import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import {
  confirmShellForegroundProcess,
  resolveAgentForegroundProcessWithAvailability
} from './agent-foreground-process'
import { resolveForegroundFallbackProcess } from './local-pty-launch-helpers'
import {
  ptyAgentForegroundContextPaths,
  ptyLastRecognizedForeground,
  ptyProcesses,
  ptyShellName
} from './local-pty-provider-state'
import { resolveStableForegroundProcess } from './stable-foreground-process'
import {
  canRevalidateCachedAgentWithoutScan,
  judgeCachedAgentJobEvidence
} from './windows-cached-agent-revalidation'
import { readWindowsConsoleAttachedProcessIds } from './windows-console-attached-processes'
import { isWindowsPtyJobReadable, readWindowsPtyJobProcessIds } from './windows-pty-job-membership'

export async function hasLocalPtyChildProcesses(id: string): Promise<boolean> {
  const proc = ptyProcesses.get(id)
  if (!proc) {
    return false
  }
  try {
    const foreground = proc.process
    const shell = ptyShellName.get(id)
    if (!shell) {
      return true
    }
    return foreground !== shell
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
    proc.process || null,
    ptyShellName.get(id)
  )
  const cachedEntry = ptyLastRecognizedForeground.get(id)
  const cachedAgent = cachedEntry?.name ?? null
  let paneMembershipUnavailable = false
  let cachedAgentAliveInJob = false
  // Why: job membership preserves a live cached agent without the whole-table
  // scan (incomplete under Windows load). Job, not console: this asks "is
  // anything besides the shell alive?", which needs no console attachment and
  // so needs no forked helper (#10857).
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
        shellPid: proc.pid,
        anchorProcessId: cachedEntry?.pid ?? null,
        identityAgeMs: Date.now() - (cachedEntry?.at ?? 0)
      })
      if (verdict === 'confirmed' || verdict === 'unproven') {
        return cachedAgent
      }
      if (verdict === 'exited') {
        // The shell stands alone in a complete, inescapable job list: no
        // successor is possible, so the identity retires before the scan.
        ptyLastRecognizedForeground.delete(id)
      } else if (verdict === 'anchor-exited' && cachedEntry) {
        // The recognized process died but another member remains -- a
        // leftover, or a restarted successor. Keep the name as unanchored,
        // age-bounded evidence and let this cycle's scan decide: deleting
        // here made a degraded scan read a mid-restart agent as an exit.
        ptyLastRecognizedForeground.set(id, { ...cachedEntry, pid: null })
      }
      cachedAgentAliveInJob = verdict === 'recheck'
      paneMembershipUnavailable = verdict === 'unavailable'
    } catch {
      paneMembershipUnavailable = true
    }
  }
  try {
    const resolution = await resolveAgentForegroundProcessWithAvailability(
      proc.pid,
      fallbackProcess,
      {
        contextPaths: ptyAgentForegroundContextPaths.get(id),
        ...(cachedEntry?.pid != null
          ? { anchorProcessId: cachedEntry.pid, anchorProcessName: cachedEntry.name }
          : {})
      }
    )
    // Why: the scan can outlive PTY teardown/id reuse; stale results must not resurrect cache for a foreign id.
    if (ptyProcesses.get(id) !== proc) {
      return null
    }
    // Why: a degraded scan reporting shell-as-foreground fires a false "agent done"; keep last recognized agent instead.
    const lastRecognizedAgent = ptyLastRecognizedForeground.get(id)?.name ?? null
    const resolvedAgent = resolution.processName
      ? recognizeAgentProcessFromCommandLine(resolution.processName)
      : null
    // A recycled anchor pid keeps job membership truthful but the identity
    // dead; the scan proving the pid now runs a non-agent settles it.
    const anchorContradicted = resolution.anchorPidForeign === true
    // Why: incomplete snapshot + unavailable job read isn't exit proof; and an
    // anchor pid still alive in the job outranks a snapshot that lost its row.
    const stableResolution =
      (paneMembershipUnavailable || cachedAgentAliveInJob) &&
      !anchorContradicted &&
      resolvedAgent === null
        ? { ...resolution, available: false }
        : resolution
    const stable = resolveStableForegroundProcess(stableResolution, lastRecognizedAgent)
    if (stable.lastRecognizedAgent && stableResolution.available) {
      // Only a positive recognition restarts the age bound.
      ptyLastRecognizedForeground.set(id, {
        name: stable.lastRecognizedAgent,
        pid:
          stable.lastRecognizedAgent === resolution.processName
            ? (resolution.processId ?? null)
            : null,
        at: Date.now()
      })
    } else if (stable.lastRecognizedAgent && cachedAgentAliveInJob && !anchorContradicted) {
      // The anchor pid in the job is proof of life; restamp so the
      // short-circuit resumes instead of scanning on every call.
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

export async function confirmLocalPtyForegroundProcess(id: string): Promise<string | null> {
  const proc = ptyProcesses.get(id)
  if (!proc) {
    return null
  }
  try {
    const resolution = await resolveAgentForegroundProcessWithAvailability(
      proc.pid,
      resolveForegroundFallbackProcess(proc.process || null, ptyShellName.get(id)),
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
    proc.pid,
    ptyShellName.get(id),
    process.platform === 'win32'
      ? { readWindowsPtyJobProcessIds: () => readWindowsPtyJobProcessIds(proc) }
      : {}
  )
  return ptyProcesses.get(id) === proc && confirmed
}
