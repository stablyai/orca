import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { getFirstCommandToken } from '../../shared/command-token-scanner'
import { resolveOuterWrapperForegroundProcess } from '../../shared/foreground-wrapper-agent'
import { recognizeAgentFromExecutablePath } from '../../shared/process-executable-recognition'
import {
  getFreshProcessTableSnapshot,
  getProcessTableSnapshot,
  type ProcessTableRow
} from '../../shared/process-table-snapshot'
import { isShellProcess } from '../../shared/shell-process-detection'
import {
  resolveWindowsAgentForegroundProcessWithAvailability,
  shouldInspectWindowsAgentForeground,
  type AgentForegroundResolutionOptions
} from './windows-agent-foreground-process'

export type { AgentForegroundResolutionOptions } from './windows-agent-foreground-process'

export type AgentForegroundProcessResolution = {
  available: boolean
  processName: string | null
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
          : fallbackProcess)
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
      processName: (await resolveAgentForegroundProcessFromPs(rows, shellPid)) ?? fallbackProcess
    }
  } catch {
    // Why: a failed scan cannot prove fallback ownership; callers retain the last recognized agent.
    return { available: false, processName: fallbackProcess }
  }
}

async function resolveAgentForegroundProcessFromPs(
  rows: ProcessTableRow[],
  shellPid: number
): Promise<string | null> {
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
  const inspected: (ProcessTableRow & { depth: number })[] = []
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
    inspected.push(candidate)
  }
  return resolveForegroundAgentFromExecutableEvidence(inspected)
}

// Why: a renamed/forked agent binary (argv0 rename, native fork at a
// non-standard path) shows an unrecognized command line, so the loop above
// misses it. Lazily resolve the real executable image ONLY for the still-
// unrecognized non-shell foreground candidates and re-run recognition on its
// basename. Cost-guarded: `ps`-scan volume is untouched (no extra `ps`), the
// lookup is per-PID cached, and only true foreground ('+') candidates probe.
async function resolveForegroundAgentFromExecutableEvidence(
  inspected: (ProcessTableRow & { depth: number })[]
): Promise<string | null> {
  for (const candidate of inspected) {
    if (!candidate.stat.includes('+') || isShellProcess(getFirstCommandToken(candidate.command))) {
      continue
    }
    const recognized = await recognizeAgentFromExecutablePath(candidate.pid)
    if (recognized) {
      return recognized.processName
    }
  }
  return null
}
