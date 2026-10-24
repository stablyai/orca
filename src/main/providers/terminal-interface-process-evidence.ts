import type { SubprocessHandle } from '../daemon/session-subprocess-handle'
import { getStrictProcessTableSnapshotWithAge } from '../../shared/process-table-snapshot-reader'
export type TerminalInterfaceSnapshot = Awaited<
  ReturnType<typeof getStrictProcessTableSnapshotWithAge>
>
import { collectDescendantsFromIndex, getProcessTableIndex } from '../../shared/process-table-index'
import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../shared/command-token-scanner'
import { isTerminalScopeWrapper } from '../daemon/terminal-scopes-runtime'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type { TerminalInterfaceEvidence } from '../../shared/terminal-interface-observation'

export function terminalInterfaceEvidenceFromRows(
  rows: readonly ProcessTableRow[],
  rootPid: number,
  capturedAgeMs: number,
  shellPath: string,
  loginWrapped = false
): TerminalInterfaceEvidence {
  const index = getProcessTableIndex(rows)
  const root = index.byPid.get(rootPid)
  const unknown: TerminalInterfaceEvidence = {
    shellForeground: false,
    children: 'unverifiable',
    capturedAgeMs
  }
  if (!root || !root.tty || root.tty === '?' || capturedAgeMs > 1000) {
    return unknown
  }
  const tree = [{ ...root, depth: 0 }, ...collectDescendantsFromIndex(index, rootPid)]
  const name = (row: ProcessTableRow): string =>
    getCommandTokenPathBasename(getFirstCommandToken(row.command)).replace(/^-/, '')
  const expected = getCommandTokenPathBasename(shellPath)
  const launchChain = new Set<number>()
  let shell: ProcessTableRow | undefined = root
  // Only the spawned root or its known launch-wrapper chain may identify the pane shell.
  while (shell && !launchChain.has(shell.pid)) {
    if (shell.tty !== root.tty || /[TZ]/.test(shell.stat)) {
      return unknown
    }
    launchChain.add(shell.pid)
    if (isShellProcess(name(shell)) && name(shell) === expected) {
      break
    }
    const wrapper =
      isTerminalScopeWrapper(getFirstCommandToken(shell.command)) ||
      (loginWrapped && shell.pid === rootPid && name(shell) === 'login')
    if (!wrapper) {
      return unknown
    }
    const children = tree.filter((row) => row.ppid === shell?.pid && !row.stat.includes('Z'))
    shell = children.length === 1 ? children[0] : undefined
  }
  if (
    !shell ||
    shell.tty !== root.tty ||
    !isShellProcess(name(shell)) ||
    name(shell) !== expected ||
    /[TZ]/.test(shell.stat)
  ) {
    return unknown
  }
  const foreground = rows.filter(
    (row) => row.tty === root.tty && row.pgid === root.tpgid && !row.stat.includes('Z')
  )
  const controlsShell = (candidate: ProcessTableRow): boolean => {
    const visited = new Set<number>()
    let current: ProcessTableRow | undefined = candidate
    while (current && !visited.has(current.pid)) {
      if (current.tty !== root.tty || /[TZ]/.test(current.stat) || !isShellProcess(name(current))) {
        return false
      }
      if (current.pid === shell?.pid) {
        return true
      }
      visited.add(current.pid)
      current = index.byPid.get(current.ppid)
    }
    return false
  }
  const children = tree.some((row) => !launchChain.has(row.pid) && !row.stat.includes('Z'))
  return {
    shellForeground:
      typeof root.tpgid === 'number' &&
      root.tpgid > 0 &&
      foreground.some((row) => row.tpgid === root.tpgid && controlsShell(row)) &&
      foreground.every(controlsShell),
    children: children ? 'children' : 'no-children',
    capturedAgeMs
  }
}

export async function inspectPosixTerminalInterface(
  rootPid: number,
  shellPath: string,
  loginWrapped = false,
  suppliedSnapshot?: TerminalInterfaceSnapshot
): Promise<TerminalInterfaceEvidence> {
  const snapshot = suppliedSnapshot ?? (await getStrictProcessTableSnapshotWithAge())
  return terminalInterfaceEvidenceFromRows(
    snapshot.rows,
    rootPid,
    snapshot.capturedAgeMs,
    shellPath,
    loginWrapped
  )
}

export async function inspectSessionTerminalInterface(
  subprocess: Pick<
    SubprocessHandle,
    'pid' | 'shellPath' | 'loginWrapped' | 'inspectChildProcesses'
  >,
  snapshot?: TerminalInterfaceSnapshot
): Promise<TerminalInterfaceEvidence> {
  if (process.platform !== 'win32') {
    return inspectPosixTerminalInterface(
      subprocess.pid,
      subprocess.shellPath ?? '',
      subprocess.loginWrapped === true,
      snapshot
    )
  }
  const children = await (subprocess.inspectChildProcesses?.(true) ?? 'unverifiable')
  return { shellForeground: children === 'no-children', children, capturedAgeMs: 0 }
}
