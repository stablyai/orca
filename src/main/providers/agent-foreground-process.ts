import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { resolveOuterWrapperForegroundIdentity } from '../../shared/foreground-wrapper-agent'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import {
  getFreshProcessTableSnapshot,
  getFreshShellForegroundSnapshot,
  getProcessTableSnapshot
} from '../../shared/process-table-snapshot-reader'
import { collectDescendantsFromIndex, getProcessTableIndex } from '../../shared/process-table-index'
import {
  resolveWindowsAgentForegroundProcessWithAvailability,
  shouldInspectWindowsAgentForeground,
  type AgentForegroundResolutionOptions
} from './windows-agent-foreground-process'
import { isShellProcess } from '../../shared/shell-process-detection'
import {
  selectForegroundProcessCandidate,
  type SelectedForegroundProcess
} from '../../shared/foreground-process-selection'
import { isWindowsShellAloneInJob } from './windows-shell-alone-in-job'
import {
  readWindowsProcessIdentityTableFresh,
  type WindowsProcessIdentityRow
} from '../windows/windows-process-table'

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
  /** PID of the process that supplied the recognized identity; omitted for fallbacks. */
  processId?: number
  /** Windows: the scan proved the caller's `anchorProcessId` is now a non-agent. */
  anchorPidForeign?: boolean
}

type ShellForegroundConfirmationOptions = {
  readWindowsPtyJobProcessIds?: () =>
    | ReadonlySet<number>
    | null
    | Promise<ReadonlySet<number> | null>
  readWindowsProcessIdentityTable?: () => Promise<WindowsProcessIdentityRow[]>
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
      return await isWindowsShellAloneInJob(
        shellPid,
        spawnedShellProcess,
        await options.readWindowsPtyJobProcessIds?.(),
        options.readWindowsProcessIdentityTable ?? readWindowsProcessIdentityTableFresh
      )
    } catch {
      // Unavailable job or process-table inspection is missing proof, never a thrown confirmation.
      return false
    }
  }
  try {
    const index = getProcessTableIndex(await getFreshShellForegroundSnapshot())
    const root = index.byPid.get(shellPid)
    if (!root) {
      return false
    }
    const tree = [{ ...root, depth: 0 }, ...collectDescendantsFromIndex(index, shellPid)]
    // Shell paths may contain spaces; command-line tokenization would truncate their basename.
    const spawnedShellBasename = spawnedShellProcess.split(/[\\/]/).pop()?.toLowerCase() ?? ''
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

/** Resolves the foreground agent name and PID; a failed scan reports unavailable so callers keep the last agent. */
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
      // A forced scan that loses the recognized fallback proves exit during confirmation.
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
      ...(resolveAgentForegroundIdentityFromPs(rows, shellPid) ?? { processName: fallbackProcess })
    }
  } catch {
    // Why: a failed scan cannot prove fallback ownership; callers retain the last recognized agent.
    return { available: false, processName: fallbackProcess }
  }
}

/** Name-only view of the foreground agent identity for callers that need no PID. */
export function resolveAgentForegroundProcessFromPs(
  rows: readonly ProcessTableRow[],
  shellPid: number
): string | null {
  return resolveAgentForegroundIdentityFromPs(rows, shellPid)?.processName ?? null
}

/** Keeps the outer wrapper's name and PID together so peer lookup never targets an embedded child. */
function resolveAgentForegroundIdentityFromPs(
  rows: readonly ProcessTableRow[],
  shellPid: number
): { processName: string; processId: number } | null {
  const found = selectAgentForegroundFromPs(rows, shellPid)
  // Pair the wrapper name with its own PID, so peer lookup never targets an embedded child.
  return found
    ? resolveOuterWrapperForegroundIdentity(
        found.selected.recognized,
        found.selected.candidate,
        found.candidates
      )
    : null
}

/** The full command line of the pane's foreground agent process, for argv-level policy. */
export async function resolveAgentForegroundCommandLine(shellPid: number): Promise<string | null> {
  try {
    const rows = await getFreshShellForegroundSnapshot()
    return selectAgentForegroundFromPs(rows, shellPid)?.selected.candidate.command ?? null
  } catch {
    return null
  }
}

function selectAgentForegroundFromPs(
  rows: readonly ProcessTableRow[],
  shellPid: number
): {
  selected: SelectedForegroundProcess
  candidates: (ProcessTableRow & { depth: number })[]
} | null {
  const index = getProcessTableIndex(rows)
  const shellRow = index.byPid.get(shellPid)
  const candidates = collectDescendantsFromIndex(index, shellPid)
  // Include the shell in the foreground gate: after Ctrl-Z it owns + while the stopped agent remains a child.
  const foregroundIsKnown =
    shellRow?.stat.includes('+') === true ||
    candidates.some((candidate) => candidate.stat.includes('+'))
  const foregroundCandidates = foregroundIsKnown
    ? candidates.filter((candidate) => candidate.stat.includes('+'))
    : candidates
  // Keep non-foreground helpers in ancestry so wrapper recognition can traverse them.
  const ancestryCandidates = shellRow ? [{ ...shellRow, depth: 0 }, ...candidates] : candidates
  const selected = selectForegroundProcessCandidate(foregroundCandidates, ancestryCandidates)
  return selected ? { selected, candidates } : null
}
