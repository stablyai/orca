import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { resolveOuterWrapperForegroundProcess } from '../../shared/foreground-wrapper-agent'
import {
  getFreshProcessTableSnapshot,
  getProcessTableSnapshot,
  type ProcessTableRow
} from '../../shared/process-table-snapshot'
import {
  resolveWindowsAgentForegroundProcessWithAvailability,
  shouldInspectWindowsAgentForeground,
  type AgentForegroundResolutionOptions
} from './windows-agent-foreground-process'
import { isShellProcess } from '../../shared/shell-process-detection'

export type { AgentForegroundResolutionOptions } from './windows-agent-foreground-process'

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

function collectDescendants<Row extends { pid: number; ppid: number }>(
  rows: Row[],
  rootPid: number
): (Row & { depth: number })[] {
  const childrenByParent = new Map<number, Row[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row)
    childrenByParent.set(row.ppid, children)
  }

  const descendants: (Row & { depth: number })[] = []
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
    const rows = await getFreshProcessTableSnapshot()
    if (!rows.some((row) => row.pid === shellPid)) {
      return false
    }
    const root = rows.find((row) => row.pid === shellPid)!
    const tree = [{ ...root, depth: 0 }, ...collectDescendants(rows, shellPid)]
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

function candidateScore(row: ProcessTableRow & { depth: number }): number {
  // Why: foreground descendants carry `+` in `ps stat` on Unix PTYs. Prefer
  // them, then prefer leaf/deeper wrappers so `node /path/bin/codex` beats the
  // parent shell but still lets the native child confirm the same identity.
  return (row.stat.includes('+') ? 10_000 : 0) + row.depth
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
    if (options.fresh && !rows.some((row) => row.pid === shellPid)) {
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

function resolveAgentForegroundProcessFromPs(
  rows: ProcessTableRow[],
  shellPid: number
): string | null {
  const shellRow = rows.find((row) => row.pid === shellPid)
  const candidates = collectDescendants(rows, shellPid).sort(
    (a, b) => candidateScore(b) - candidateScore(a)
  )
  // Why: `+` in `ps stat` marks the process holding the terminal foreground.
  // The root shell can hold it after Ctrl-Z, so use the whole PTY tree as the
  // foreground gate; otherwise a stopped agent child still masquerades as live.
  const foregroundIsKnown =
    shellRow?.stat.includes('+') === true ||
    candidates.some((candidate) => candidate.stat.includes('+'))
  for (const candidate of candidates) {
    if (foregroundIsKnown && !candidate.stat.includes('+')) {
      continue
    }
    const recognized = recognizeAgentProcessFromCommandLine(candidate.command)
    if (recognized) {
      // Why: return the outer wrapper (omp) rather than the deeper wrapped child
      // (pi) of a shell→omp→pi tree — see resolveOuterWrapperForegroundProcess.
      return resolveOuterWrapperForegroundProcess(recognized, candidate, candidates)
    }
  }
  return null
}
