import { execFile } from 'child_process'
import { promisify } from 'util'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import {
  resolveWindowsAgentForegroundProcess,
  shouldInspectWindowsAgentForeground,
  type AgentForegroundResolutionOptions
} from './windows-agent-foreground-process'

export type { AgentForegroundResolutionOptions } from './windows-agent-foreground-process'

const execFileAsync = promisify(execFile)

type ProcessRow = {
  pid: number
  ppid: number
  stat: string
  command: string
}

function parsePsRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    if (!match) {
      continue
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      stat: match[3],
      command: match[4]
    })
  }
  return rows
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

function candidateScore(row: ProcessRow & { depth: number }): number {
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
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,stat=,command='], {
      encoding: 'utf8',
      timeout: 3000
    })
    return resolveAgentForegroundProcessFromPs(stdout, shellPid) ?? fallbackProcess
  } catch {
    // Fall through to node-pty's process name. Foreground process inspection is
    // best-effort because terminal identity should never break PTY operation.
  }

  return fallbackProcess
}

function resolveAgentForegroundProcessFromPs(stdout: string, shellPid: number): string | null {
  const rows = parsePsRows(stdout)
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
