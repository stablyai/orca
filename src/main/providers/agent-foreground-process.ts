import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { resolveOuterWrapperForegroundProcess } from '../../shared/foreground-wrapper-agent'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import {
  getFreshProcessTableSnapshot,
  getProcessTableSnapshot
} from '../../shared/process-table-snapshot-reader'
import { collectDescendantsFromIndex, getProcessTableIndex } from '../../shared/process-table-index'
import {
  resolveWindowsAgentForegroundProcessWithAvailability,
  shouldInspectWindowsAgentForeground,
  type AgentForegroundResolutionOptions
} from './windows-agent-foreground-process'
import { isShellProcess } from '../../shared/shell-process-detection'
import { selectForegroundProcessCandidate } from '../../shared/foreground-process-selection'

export type { AgentForegroundResolutionOptions } from './windows-agent-foreground-process'
export {
  resolveAgentForegroundProcessesBatch,
  resolveAgentForegroundProcessesFromIndex,
  resolveRemoteForegroundEvidence,
  toForegroundProcessEvidence,
  type BatchedForegroundProcessOptions,
  type BatchedForegroundProcessRequest,
  type BatchedForegroundProcessResult
} from './agent-foreground-process-batch'

export type AgentForegroundProcessResolution = {
  available: boolean
  processName: string | null
  /**
   * Windows: pid of the process a recognized name belongs to — a liveness
   * anchor callers may check against the pane's job. Absent when the name is a
   * fallback, ambiguous, or resolved on POSIX (where `+` already marks it).
   */
  processId?: number
  /** Windows: the scan proved the caller's `anchorProcessId` is now a non-agent. */
  anchorPidForeign?: boolean
}

type ShellForegroundConfirmationOptions = {
  readWindowsPtyJobProcessIds?: () =>
    | ReadonlySet<number>
    | null
    | Promise<ReadonlySet<number> | null>
}

function commandExecutable(command: string): string {
  const trimmed = command.trim().replace(/^[-]/, '')
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const closingQuote = trimmed.indexOf(trimmed[0], 1)
    return closingQuote === -1 ? trimmed.slice(1) : trimmed.slice(1, closingQuote)
  }
  return trimmed.split(/\s+/, 1)[0] ?? ''
}

function executableBasename(command: string): string {
  return commandExecutable(command).split(/[\\/]/).pop()?.toLowerCase() ?? ''
}

export async function confirmShellForegroundProcess(
  shellPid: number | null | undefined,
  spawnedShellProcess: string | null | undefined,
  options: ShellForegroundConfirmationOptions = {}
): Promise<boolean> {
  if (!shellPid || !spawnedShellProcess || !isShellProcess(spawnedShellProcess)) {
    return false
  }
  if (process.platform === 'win32') {
    try {
      const processIds = await options.readWindowsPtyJobProcessIds?.()
      return processIds?.size === 1 && processIds.has(shellPid)
    } catch {
      // Unavailable job inspection is missing proof, never a thrown confirmation.
      return false
    }
  }
  try {
    const index = getProcessTableIndex(await getFreshProcessTableSnapshot())
    const root = index.byPid.get(shellPid)
    if (!root) {
      return false
    }
    const tree = [{ ...root, depth: 0 }, ...collectDescendantsFromIndex(index, shellPid)]
    const spawnedShellBasename = executableBasename(spawnedShellProcess)
    const foregroundShell = tree
      .filter(
        (row) =>
          executableBasename(row.command) === spawnedShellBasename &&
          isShellProcess(commandExecutable(row.command))
      )
      .sort((left, right) => left.depth - right.depth)[0]
    if (tree.some((row) => row.depth > 0 && row.stat.includes('T'))) {
      return false
    }
    const confirmed = foregroundShell?.stat.includes('+') === true
    return confirmed
  } catch {
    return false
  }
}

export async function resolveAgentForegroundProcess(
  shellPid: number | null | undefined,
  fallbackProcess: string | null,
  options: AgentForegroundResolutionOptions = {}
): Promise<string | null> {
  return (await resolveAgentForegroundProcessWithAvailability(shellPid, fallbackProcess, options))
    .processName
}

export async function resolveAgentForegroundProcessWithAvailability(
  shellPid: number | null | undefined,
  fallbackProcess: string | null,
  options: AgentForegroundResolutionOptions = {}
): Promise<AgentForegroundProcessResolution> {
  if (!shellPid) {
    return { available: false, processName: fallbackProcess }
  }

  if (process.platform === 'win32') {
    if (
      !fallbackProcess ||
      (!shouldInspectWindowsAgentForeground(fallbackProcess) && !options.forceProcessScan)
    ) {
      return { available: true, processName: fallbackProcess }
    }
    const resolution = await resolveWindowsAgentForegroundProcessWithAvailability(
      shellPid,
      fallbackProcess,
      options
    )
    return {
      available: resolution.available,
      // Why: a forced confirmation scan that no longer sees the recognized
      // fallback is authoritative evidence that the agent exited meanwhile.
      processName:
        resolution.processName ??
        (options.forceProcessScan && recognizeAgentProcessFromCommandLine(fallbackProcess)
          ? null
          : fallbackProcess),
      // The anchor only travels with the name it proved, never with a fallback.
      ...(resolution.processName !== null && resolution.processId !== undefined
        ? { processId: resolution.processId }
        : {}),
      ...(resolution.anchorPidForeign ? { anchorPidForeign: true } : {})
    }
  }

  try {
    const rows = options.fresh
      ? await getFreshProcessTableSnapshot()
      : await getProcessTableSnapshot()
    if (options.fresh && !getProcessTableIndex(rows).byPid.has(shellPid)) {
      return { available: false, processName: fallbackProcess }
    }
    return {
      available: true,
      processName: resolveAgentForegroundProcessFromPs(rows, shellPid) ?? fallbackProcess
    }
  } catch {
    // Why: a failed scan cannot prove fallback ownership; callers retain the last recognized agent.
    return { available: false, processName: fallbackProcess }
  }
}

export function resolveAgentForegroundProcessFromPs(
  rows: readonly ProcessTableRow[],
  shellPid: number
): string | null {
  // Memoized per snapshot identity, so the caller's own index build is reused.
  const index = getProcessTableIndex(rows)
  const shellRow = index.byPid.get(shellPid)
  const candidates = collectDescendantsFromIndex(index, shellPid)
  // Why: `+` in `ps stat` marks the process holding the terminal foreground.
  // The root shell can hold it after Ctrl-Z, so use the whole PTY tree as the
  // foreground gate; otherwise a stopped agent child still masquerades as live.
  const foregroundIsKnown =
    shellRow?.stat.includes('+') === true ||
    candidates.some((candidate) => candidate.stat.includes('+'))
  const foregroundCandidates = foregroundIsKnown
    ? candidates.filter((candidate) => candidate.stat.includes('+'))
    : candidates
  // Keep the complete process tree for ancestry checks. A recognized agent can
  // sit above a non-foreground helper before another recognized process; the
  // helper is filtered from selection but must remain traversable.
  const ancestryCandidates = shellRow ? [{ ...shellRow, depth: 0 }, ...candidates] : candidates
  const selected = selectForegroundProcessCandidate(foregroundCandidates, ancestryCandidates)
  if (selected) {
    // Why: return the outer wrapper (omp) rather than the deeper wrapped child
    // (pi) of a shell→omp→pi tree — see resolveOuterWrapperForegroundProcess.
    return resolveOuterWrapperForegroundProcess(selected.recognized, selected.candidate, candidates)
  }
  return null
}
