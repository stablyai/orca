import type { PtyChildProcessVerdict } from '../../shared/terminal-process-inspection'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { getCheapProcessTableSnapshot } from '../../shared/cheap-process-table-snapshot-reader'
import {
  getProcessTableSnapshot,
  getStrictProcessTableSnapshotWithAge
} from '../../shared/process-table-snapshot-reader'
import { confirmShellForegroundProcess } from './agent-foreground-process'
import {
  createPtyForegroundResolver,
  ptyProcessNameIsSpawnFile
} from '../daemon/pty-subprocess/spawn-file-foreground-process'
import {
  inspectSpawnFileChildProcessesFromRows,
  inspectSpawnFileWindowsChildProcesses
} from '../daemon/pty-subprocess/spawn-file-child-processes'
import { buildPaneProcessFingerprint } from './posix-pane-foreground-fingerprint'
import { isRetiredPtyMaster } from '../pty/node-pty-master-fd-retirement'
import { ptyShellProcessId } from '../windows/windows-pty-job'
import { resolveForegroundFallbackProcess } from './local-pty-launch-helpers'
import {
  ptyAgentForegroundContextPaths,
  ptyLastRecognizedForeground,
  ptyProcesses,
  getPtyShellName,
  ptyShellPath
} from './local-pty-provider-state'
import { resolveStableForegroundProcess } from './stable-foreground-process'
import {
  canRevalidateCachedAgentWithoutScan,
  judgeCachedAgentJobEvidence
} from './windows-cached-agent-revalidation'
import { readWindowsConsoleAttachedProcessIds } from './windows-console-attached-processes'
import { isWindowsPtyJobReadable, readWindowsPtyJobProcessIds } from './windows-pty-job-membership'

/** Retired masters still report the spawn name; inspect the descriptor first so unreadability cannot prove idle. */
export async function inspectLocalPtyChildProcesses(
  id: string,
  fresh = true,
  ignoreDetached = false
): Promise<PtyChildProcessVerdict> {
  const proc = ptyProcesses.get(id)
  if (!proc) {
    return 'no-children'
  }
  if (isRetiredPtyMaster(proc)) {
    return 'unverifiable'
  }
  try {
    if (process.platform === 'win32') {
      const verdict = await inspectSpawnFileWindowsChildProcesses(
        proc,
        ptyShellPath.get(id) ?? '',
        fresh,
        ignoreDetached
      )
      return ptyProcesses.get(id) === proc ? verdict : 'unverifiable'
    }
    if (ptyProcessNameIsSpawnFile(proc)) {
      const snapshot = await getStrictProcessTableSnapshotWithAge()
      return ptyProcesses.get(id) === proc
        ? inspectSpawnFileChildProcessesFromRows(
            snapshot.rows,
            proc.pid,
            getPtyShellName(id) ?? null
          )
        : 'unverifiable'
    }
    const foreground = proc.process
    const shell = getPtyShellName(id)
    if (!shell) {
      return 'children'
    }
    return foreground === shell ? 'no-children' : 'children'
  } catch {
    // An unreadable PTY is not evidence that its children exited.
    return 'unverifiable'
  }
}

export async function hasLocalPtyChildProcesses(id: string): Promise<boolean> {
  return (await inspectLocalPtyChildProcesses(id)) !== 'no-children'
}

/** Reprove an anchored POSIX agent from an unchanged cheap-tier fingerprint; unanchored panes still need discovery. */
async function revalidateCachedPosixAgent(
  proc: { pid: number },
  cachedEntry: {
    name: string
    steady?: { fingerprint: string; fallbackProcess: string | null } | null
  },
  fallbackProcess: string | null
): Promise<boolean> {
  const steady = cachedEntry.steady
  if (!steady || steady.fallbackProcess !== fallbackProcess) {
    return false
  }
  try {
    const observed = await buildPaneProcessFingerprint(
      await getCheapProcessTableSnapshot(),
      proc.pid
    )
    return observed !== null && observed === steady.fingerprint
  } catch {
    return false
  }
}

export async function getLocalPtyForegroundProcess(id: string): Promise<string | null> {
  const proc = ptyProcesses.get(id)
  if (!proc) {
    ptyLastRecognizedForeground.delete(id)
    return null
  }
  const fallbackProcess = resolveForegroundFallbackProcess(
    ptyProcessNameIsSpawnFile(proc) ? (getPtyShellName(id) ?? null) : proc.process || null,
    getPtyShellName(id)
  )
  const cachedEntry = ptyLastRecognizedForeground.get(id)
  const cachedAgent = cachedEntry?.name ?? null
  let paneMembershipUnavailable = false
  let cachedAgentAliveInJob = false
  // Job membership revalidates cached Windows agents without a fragile whole-table scan or console helper (#10857).
  if (
    process.platform === 'win32' &&
    canRevalidateCachedAgentWithoutScan(cachedAgent, fallbackProcess)
  ) {
    try {
      const paneProcessIds = readWindowsPtyJobProcessIds(proc)
      if (ptyProcesses.get(id) !== proc) {
        return null
      }
      const verdict = judgeCachedAgentJobEvidence({
        jobProcessIds: paneProcessIds,
        jobSupported: isWindowsPtyJobReadable(),
        shellPid: ptyShellProcessId(proc) ?? proc.pid,
        anchorProcessId: cachedEntry?.pid ?? null,
        identityAgeMs: Date.now() - (cachedEntry?.at ?? 0)
      })
      if (verdict === 'confirmed' || verdict === 'unproven') {
        return cachedAgent
      }
      if (verdict === 'exited') {
        // Complete, inescapable job membership proves only the shell remains; retire identity before scanning.
        ptyLastRecognizedForeground.delete(id)
      } else if (verdict === 'anchor-exited' && cachedEntry) {
        // Other members may include a restarted successor; retain age-bounded unanchored identity across a degraded scan.
        ptyLastRecognizedForeground.set(id, { ...cachedEntry, pid: null })
      }
      cachedAgentAliveInJob = verdict === 'recheck'
      paneMembershipUnavailable = verdict === 'unavailable'
    } catch {
      paneMembershipUnavailable = true
    }
  }
  if (
    process.platform !== 'win32' &&
    cachedEntry &&
    cachedAgent !== null &&
    (await revalidateCachedPosixAgent(proc, cachedEntry, fallbackProcess))
  ) {
    if (ptyProcesses.get(id) !== proc) {
      return null
    }
    ptyLastRecognizedForeground.set(id, { ...cachedEntry, at: Date.now() })
    return cachedAgent
  }
  try {
    const resolution = await createPtyForegroundResolver(proc)(proc.pid, fallbackProcess, {
      contextPaths: ptyAgentForegroundContextPaths.get(id),
      ...(cachedEntry?.pid != null
        ? { anchorProcessId: cachedEntry.pid, anchorProcessName: cachedEntry.name }
        : {})
    })
    // Why: the scan can outlive PTY teardown/id reuse; stale results must not resurrect cache for a foreign id.
    if (ptyProcesses.get(id) !== proc) {
      return null
    }
    // Why: a degraded scan reporting shell-as-foreground fires a false "agent done"; keep last recognized agent instead.
    const lastRecognizedAgent = ptyLastRecognizedForeground.get(id)?.name ?? null
    const resolvedAgent = resolution.processName
      ? recognizeAgentProcessFromCommandLine(resolution.processName)
      : null
    // A scan proving anchor PID reuse overrides otherwise valid job membership.
    const anchorContradicted = resolution.anchorPidForeign === true
    // An unavailable job read cannot prove exit; a live job anchor outranks a snapshot missing its row.
    const stableResolution =
      (paneMembershipUnavailable || cachedAgentAliveInJob) &&
      !anchorContradicted &&
      resolvedAgent === null
        ? { ...resolution, available: false }
        : resolution
    const stable = resolveStableForegroundProcess(stableResolution, lastRecognizedAgent)
    if (stable.lastRecognizedAgent && stableResolution.available) {
      const steady = await readPosixSteadyState(proc.pid, fallbackProcess)
      if (ptyProcesses.get(id) !== proc) {
        return null
      }
      // Only a positive recognition restarts the age bound.
      ptyLastRecognizedForeground.set(id, {
        name: stable.lastRecognizedAgent,
        pid:
          stable.lastRecognizedAgent === resolution.processName
            ? (resolution.processId ?? null)
            : null,
        at: Date.now(),
        steady
      })
    } else if (stable.lastRecognizedAgent && cachedAgentAliveInJob && !anchorContradicted) {
      // Refresh confirmed anchor liveness so the cheap path resumes after this scan.
      const entry = ptyLastRecognizedForeground.get(id)
      if (entry) {
        ptyLastRecognizedForeground.set(id, { ...entry, at: Date.now() })
      }
    } else if (!stable.lastRecognizedAgent) {
      ptyLastRecognizedForeground.delete(id)
    }
    return stable.processName
  } catch {
    if (ptyProcesses.get(id) !== proc) {
      return null
    }
    // Why: an inspection error is a degraded read; fall back to last recognized agent (null reads as an exit).
    return ptyLastRecognizedForeground.get(id)?.name ?? null
  }
}

/** Null for Windows/unfenced panes, requiring a full scan next time. */
async function readPosixSteadyState(
  shellPid: number,
  fallbackProcess: string | null
): Promise<{ fingerprint: string; fallbackProcess: string | null } | null> {
  if (process.platform === 'win32') {
    return null
  }
  try {
    const fingerprint = await buildPaneProcessFingerprint(await getProcessTableSnapshot(), shellPid)
    return fingerprint === null ? null : { fingerprint, fallbackProcess }
  } catch {
    return null
  }
}

export async function confirmLocalPtyForegroundProcess(id: string): Promise<string | null> {
  const proc = ptyProcesses.get(id)
  if (!proc) {
    return null
  }
  try {
    const resolution = await createPtyForegroundResolver(proc)(
      proc.pid,
      resolveForegroundFallbackProcess(
        ptyProcessNameIsSpawnFile(proc) ? (getPtyShellName(id) ?? null) : proc.process || null,
        getPtyShellName(id)
      ),
      {
        contextPaths: ptyAgentForegroundContextPaths.get(id),
        fresh: true,
        ...(process.platform === 'win32'
          ? {
              forceProcessScan: true,
              readWindowsConsoleAttachedProcessIds: () =>
                readWindowsConsoleAttachedProcessIds(proc.pid)
            }
          : {})
      }
    )
    // Why: a fresh scan can outlive this PTY id; never publish identity from an exited or same-id-reusing session.
    if (ptyProcesses.get(id) !== proc) {
      return null
    }
    return resolution.available ? resolution.processName : null
  } catch {
    return null
  }
}

export async function confirmLocalPtyShellForeground(id: string): Promise<boolean> {
  const proc = ptyProcesses.get(id)
  if (!proc) {
    return false
  }
  const confirmed = await confirmShellForegroundProcess(
    ptyShellProcessId(proc),
    ptyShellPath.get(id),
    process.platform === 'win32'
      ? { readWindowsPtyJobProcessIds: () => readWindowsPtyJobProcessIds(proc) }
      : {}
  )
  return ptyProcesses.get(id) === proc && confirmed
}
