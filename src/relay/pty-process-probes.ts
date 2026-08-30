import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess,
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from '../shared/agent-process-recognition'
import { getFirstCommandToken } from '../shared/command-token-scanner'
import { getProcessTableSnapshot, type ProcessTableRow } from '../shared/process-table-snapshot'
import {
  resolveOuterWrapperForegroundProcess,
  shouldInspectOuterWrapperForegroundProcess
} from '../shared/foreground-wrapper-agent'
import { isShellProcess } from '../shared/shell-process-detection'
import type {
  PtyChildProcessesEvidence,
  PtyForegroundProcessEvidence
} from '../shared/pty-process-inspection-evidence'
import {
  resolveWindowsAgentForegroundProcess,
  shouldInspectWindowsAgentForeground
} from '../main/providers/windows-agent-foreground-process'
import { queryWindowsPaneProcessInventory } from '../main/providers/windows-foreground-process-rows'
import { runProcess, type ProcessResult } from '../shared/child-process/run-process'

const PROBE_TIMEOUT_MS = 3000

/**
 * Check whether a process has child processes (via pgrep).
 *
 * Legacy collapse kept for the standalone `pty.hasChildProcesses` RPC: every
 * probe failure reads as `false`. Completion-sensitive callers must use
 * `probeProcessChildren`, whose verdict keeps "could not ask" distinct.
 */
export async function processHasChildren(pid: number): Promise<boolean> {
  try {
    const result = await runProbe('pgrep', ['-P', String(pid)])
    return result.code === 0 && result.stdout.trim().length > 0
  } catch {
    return false
  }
}

// Rejects only when the probe binary could not be spawned at all (ENOENT,
// fork pressure); a probe that ran resolves with its exit status as data.
function runProbe(program: string, args: string[]): Promise<ProcessResult> {
  return runProcess({ program, args, timeoutMs: PROBE_TIMEOUT_MS })
}

// Exit code 1 without a kill signal: pgrep/ps RAN and matched nothing — that
// is positive absence, not a failed probe.
function subprocessRanAndMatchedNothing(result: ProcessResult): boolean {
  return result.code === 1 && !result.timedOut && !result.signal
}

function describeProcessProbeFailure(command: string, result: ProcessResult): string {
  if (result.timedOut || result.signal) {
    return `${command} did not answer before its deadline`
  }
  return `${command} could not run: exit ${result.code ?? 'unknown'}`
}

function describeProcessSpawnFailure(command: string, error: unknown): string {
  const failure = error as NodeJS.ErrnoException | undefined
  return `${command} could not run: ${failure?.code ?? failure?.message ?? 'unknown failure'}`
}

/**
 * Probe whether the PTY's root process has live children, keeping the
 * live / unverifiable / exited contract: a probe that could not run (pgrep
 * missing, fork pressure, timeout) is `unverifiable`, never `exited`.
 */
export async function probeProcessChildren(pid: number): Promise<PtyChildProcessesEvidence> {
  if (process.platform === 'win32') {
    // pgrep does not exist on Windows hosts; ask the native process table the
    // relay already reads for foreground resolution (TTL-cached snapshot).
    const inventory = await queryWindowsPaneProcessInventory(pid)
    if (!inventory) {
      return {
        verdict: 'unverifiable',
        reason: 'the Windows process table could not observe the PTY root'
      }
    }
    return inventory.candidates.length > 0 ? { verdict: 'live' } : { verdict: 'exited' }
  }
  let result: ProcessResult
  try {
    result = await runProbe('pgrep', ['-P', String(pid)])
  } catch (error) {
    return { verdict: 'unverifiable', reason: describeProcessSpawnFailure('pgrep', error) }
  }
  if (result.code === 0) {
    return result.stdout.trim().length > 0 ? { verdict: 'live' } : { verdict: 'exited' }
  }
  if (subprocessRanAndMatchedNothing(result)) {
    return { verdict: 'exited' }
  }
  return { verdict: 'unverifiable', reason: describeProcessProbeFailure('pgrep', result) }
}

// Why: signal 0 probes existence without delivering a signal. Only ESRCH ("no
// such process") proves the pid is gone; EPERM means it exists but is
// unsignalable, so treat every non-ESRCH outcome as alive. Kept conservative so
// a liveness check can only ever declare a *provably* dead process dead.
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function collectDescendants(
  rows: ProcessTableRow[],
  rootPid: number
): (ProcessTableRow & { depth: number })[] {
  const childrenByParent = new Map<number, ProcessTableRow[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row)
    childrenByParent.set(row.ppid, children)
  }

  const descendants: (ProcessTableRow & { depth: number })[] = []
  const stack = (childrenByParent.get(rootPid) ?? []).map((row) => ({ row, depth: 1 }))
  while (stack.length > 0) {
    const { row, depth } = stack.pop()!
    descendants.push({ ...row, depth })
    for (const child of childrenByParent.get(row.pid) ?? []) {
      stack.push({ row: child, depth: depth + 1 })
    }
  }
  return descendants
}

function candidateScore(row: ProcessTableRow & { depth: number }): number {
  return (row.stat.includes('+') ? 10_000 : 0) + row.depth
}

function processCommandToken(command: string): string {
  return getFirstCommandToken(command)
}

function candidateMatchesFallbackWrapper(
  candidate: ProcessTableRow,
  fallbackProcess: string
): boolean {
  return isExpectedAgentProcess(processCommandToken(candidate.command), fallbackProcess)
}

async function getRecognizedForegroundDescendant(
  pid: number,
  fallbackProcess?: string | null
): Promise<string | null> {
  try {
    const rows = await getProcessTableSnapshot()
    const root = rows.find((row) => row.pid === pid)
    const candidates = collectDescendants(rows, pid).sort(
      (a, b) => candidateScore(b) - candidateScore(a)
    )
    // Why: SSH relays do not have the daemon's async wrapper cache. Inspect the
    // remote process tree so node/python agent entrypoints become real agents.
    const foregroundIsKnown =
      root?.stat.includes('+') === true ||
      candidates.some((candidate) => candidate.stat.includes('+'))
    const foregroundCandidates = foregroundIsKnown
      ? candidates.filter((candidate) => candidate.stat.includes('+'))
      : candidates
    const inspectionCandidates =
      fallbackProcess && isAgentForegroundWrapperProcess(fallbackProcess)
        ? foregroundCandidates.filter((candidate) =>
            candidateMatchesFallbackWrapper(candidate, fallbackProcess)
          )
        : foregroundCandidates
    if (
      fallbackProcess &&
      isAgentForegroundWrapperProcess(fallbackProcess) &&
      inspectionCandidates.length !== 1
    ) {
      return null
    }
    for (const candidate of inspectionCandidates) {
      const recognized = recognizeAgentProcessFromCommandLine(candidate.command)
      if (recognized) {
        // Why: return the outer wrapper (omp) rather than the deeper wrapped child
        // (pi) of a shell→omp→pi tree — see resolveOuterWrapperForegroundProcess.
        return resolveOuterWrapperForegroundProcess(recognized, candidate, candidates)
      }
    }
  } catch {
    // Fall through to node-pty's process name or the root command name.
  }
  return null
}

/**
 * Get the foreground process name of a given pid (via ps).
 *
 * Legacy collapse kept for the standalone `pty.getForegroundProcess` RPC and
 * pane titles: an unverifiable observation reads as `null`. Completion-
 * sensitive callers must use `observeForegroundProcess`.
 */
export async function getForegroundProcessName(
  pid: number,
  fallbackProcess?: string | null
): Promise<string | null> {
  const evidence = await observeForegroundProcess(pid, fallbackProcess)
  return evidence.verdict === 'observed' ? evidence.processName : null
}

function observedForeground(processName: string | null): PtyForegroundProcessEvidence {
  return { verdict: 'observed', processName }
}

/**
 * Observe the foreground process, keeping "could not ask" distinct from
 * "observed nothing". Fallback names come from node-pty's own record of the
 * terminal's foreground process — a genuine observation even when descendant
 * enrichment fails. Only the last-resort `ps` read can be unverifiable: exit 1
 * proves the pid is gone (`observed` + null), while a probe that could not run
 * proves nothing.
 */
export async function observeForegroundProcess(
  pid: number,
  fallbackProcess?: string | null
): Promise<PtyForegroundProcessEvidence> {
  if (fallbackProcess) {
    const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
    if (fallbackRecognition) {
      // Why: node-pty can report OMP's wrapped Pi; enrich only that ambiguous
      // fallback so authoritative OMP reads keep the zero-subprocess fast path.
      if (shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)) {
        if (process.platform === 'win32') {
          return observedForeground(
            (await resolveWindowsAgentForegroundProcess(pid, fallbackProcess, {})) ??
              fallbackRecognition.processName
          )
        }
        return observedForeground(
          (await getRecognizedForegroundDescendant(pid, fallbackProcess)) ??
            fallbackRecognition.processName
        )
      }
      return observedForeground(fallbackRecognition.processName)
    }
    if (process.platform === 'win32') {
      if (!shouldInspectWindowsAgentForeground(fallbackProcess)) {
        return observedForeground(fallbackProcess)
      }
      return observedForeground(
        (await resolveWindowsAgentForegroundProcess(pid, fallbackProcess, {})) ?? fallbackProcess
      )
    }
    if (!isShellProcess(fallbackProcess) && !isAgentForegroundWrapperProcess(fallbackProcess)) {
      return observedForeground(fallbackProcess)
    }
  }
  const recognized = await getRecognizedForegroundDescendant(pid, fallbackProcess)
  if (recognized) {
    return observedForeground(recognized)
  }
  if (fallbackProcess) {
    return observedForeground(fallbackProcess)
  }
  let result: ProcessResult
  try {
    result = await runProbe('ps', ['-o', 'comm=', '-p', String(pid)])
  } catch (error) {
    return { verdict: 'unverifiable', reason: describeProcessSpawnFailure('ps', error) }
  }
  if (result.code === 0) {
    return observedForeground(result.stdout.trim() || null)
  }
  if (subprocessRanAndMatchedNothing(result)) {
    return observedForeground(null)
  }
  return { verdict: 'unverifiable', reason: describeProcessProbeFailure('ps', result) }
}
