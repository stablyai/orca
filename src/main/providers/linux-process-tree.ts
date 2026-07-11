import { readFile } from 'node:fs/promises'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'

const MAX_PROCESS_TREE_NODES = 256

type ProcStat = ProcessTableRow & {
  processGroupId: number
  terminalForegroundGroupId: number
  ttyNumber: number
}

export function parseLinuxProcStat(value: string): ProcStat | null {
  const closeParen = value.lastIndexOf(')')
  const openParen = value.indexOf('(')
  if (openParen < 0 || closeParen <= openParen) {
    return null
  }
  const pid = Number(value.slice(0, openParen).trim())
  const fields = value
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/)
  const state = fields[0]
  const ppid = Number(fields[1])
  const processGroupId = Number(fields[2])
  const ttyNumber = Number(fields[4])
  const terminalForegroundGroupId = Number(fields[5])
  if (
    !Number.isInteger(pid) ||
    !state ||
    !Number.isInteger(ppid) ||
    !Number.isInteger(processGroupId) ||
    !Number.isInteger(ttyNumber) ||
    !Number.isInteger(terminalForegroundGroupId)
  ) {
    return null
  }
  const foreground = ttyNumber !== 0 && processGroupId === terminalForegroundGroupId
  return {
    pid,
    ppid,
    stat: `${state}${foreground ? '+' : ''}`,
    command: value.slice(openParen + 1, closeParen),
    processGroupId,
    terminalForegroundGroupId,
    ttyNumber
  }
}

async function readProcFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function parseChildren(value: string | null): number[] {
  if (!value) {
    return []
  }
  return value
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

/**
 * Read only one PTY shell's Linux process subtree. A host-wide `ps -axo`
 * becomes extremely expensive on container hosts with thousands of processes.
 */
export async function getLinuxProcessTreeSnapshot(rootPid: number): Promise<ProcessTableRow[]> {
  const rows: ProcessTableRow[] = []
  const pending = [rootPid]
  const visited = new Set<number>()

  while (pending.length > 0 && visited.size < MAX_PROCESS_TREE_NODES) {
    const pid = pending.pop()!
    if (visited.has(pid)) {
      continue
    }
    visited.add(pid)
    const [statValue, cmdlineValue, childrenValue] = await Promise.all([
      readProcFile(`/proc/${pid}/stat`),
      readProcFile(`/proc/${pid}/cmdline`),
      readProcFile(`/proc/${pid}/task/${pid}/children`)
    ])
    if (!statValue) {
      continue
    }
    const parsed = parseLinuxProcStat(statValue)
    if (!parsed) {
      continue
    }
    const command = cmdlineValue?.split('\0').join(' ').trim() || parsed.command
    rows.push({ pid: parsed.pid, ppid: parsed.ppid, stat: parsed.stat, command })
    for (const childPid of parseChildren(childrenValue)) {
      if (!visited.has(childPid)) {
        pending.push(childPid)
      }
    }
  }

  return rows
}
