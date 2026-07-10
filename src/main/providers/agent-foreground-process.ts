import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { getProcessTableSnapshot, type ProcessTableRow } from '../../shared/process-table-snapshot'
import {
  resolveWindowsAgentForegroundProcess,
  shouldInspectWindowsAgentForeground,
  type AgentForegroundResolutionOptions
} from './windows-agent-foreground-process'

export type { AgentForegroundResolutionOptions } from './windows-agent-foreground-process'

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
  if (!shellPid) {
    return fallbackProcess
  }

  if (process.platform === 'win32') {
    if (!fallbackProcess || !shouldInspectWindowsAgentForeground(fallbackProcess)) {
      return fallbackProcess
    }
    return (
      (await resolveWindowsAgentForegroundProcess(shellPid, fallbackProcess, options)) ??
      fallbackProcess
    )
  }

  try {
    const rows = await getProcessTableSnapshot()
    return resolveAgentForegroundProcessFromPs(rows, shellPid) ?? fallbackProcess
  } catch {
    // Fall through to node-pty's process name. Foreground process inspection is
    // best-effort because terminal identity should never break PTY operation.
  }

  return fallbackProcess
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
      return recognized.processName
    }
  }
  return null
}
