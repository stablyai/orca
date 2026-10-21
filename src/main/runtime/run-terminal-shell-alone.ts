/**
 * Proof that a run terminal's shell is alone at its prompt, read from the execution host's own
 * process table. The daemon's shell-ownership flag cannot carry it: that flag turns 'shell' only
 * after a full-screen command exits, so a plain "command not found" or an agent that already
 * exited never sets it. Every failure to observe reads as unproven.
 */
import { confirmShellForegroundProcess } from '../providers/agent-foreground-process'
import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../shared/command-token-scanner'
import { getFreshProcessTableSnapshot } from '../../shared/process-table-snapshot-reader'
import { collectDescendantsFromIndex, getProcessTableIndex } from '../../shared/process-table-index'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'

/** POSIX: the PTY's root shell owns the terminal's foreground group and nothing under it is stopped. */
export async function confirmRootShellAloneFromProcessTable(rootPid: number): Promise<boolean> {
  try {
    const root = getProcessTableIndex(await getFreshProcessTableSnapshot()).byPid.get(rootPid)
    const executable = root?.command.trim().split(/\s+/, 1)[0] ?? ''
    if (!isShellProcess(executable)) {
      return false
    }
    return await confirmShellForegroundProcess(rootPid, executable)
  } catch {
    return false
  }
}

/** Windows: the host's job-based child census found nothing under the shell. */
export function inspectionShowsShellAlone(inspection: TerminalProcessInspection | null): boolean {
  if (!inspection || inspection.verdict === 'unverifiable') {
    return false
  }
  return (
    inspection.childProcessEvidence === 'no-children' &&
    (inspection.foregroundProcess === null || isShellProcess(inspection.foregroundProcess))
  )
}

/**
 * POSIX: nothing but the PTY's shell and its launch wrapper (macOS `login`) lives in its tree,
 * background and stopped jobs included. A malformed capture proves nothing.
 */
export async function confirmRootShellHasNoChildrenFromProcessTable(
  rootPid: number
): Promise<boolean> {
  try {
    const rows = await getFreshProcessTableSnapshot(true)
    const index = getProcessTableIndex(rows)
    const root = index.byPid.get(rootPid)
    if (!root || !root.tty || root.tty === '?' || root.stat.includes('Z')) {
      return false
    }
    const executable = (command: string): string =>
      getCommandTokenPathBasename(getFirstCommandToken(command)).replace(/^-/, '')
    const tree = collectDescendantsFromIndex(index, rootPid)
    const allowed = new Set([rootPid])
    if (!isShellProcess(executable(root.command))) {
      if (
        process.platform !== 'darwin' ||
        getFirstCommandToken(root.command) !== '/usr/bin/login'
      ) {
        return false
      }
      const shell = tree.find(
        (row) =>
          row.ppid === rootPid && !row.stat.includes('Z') && isShellProcess(executable(row.command))
      )
      const loginCommand = /^\/usr\/bin\/login -flpq \S+ (.*)$/.exec(root.command)?.[1]
      // The bash trampoline is not the configured shell: only its fixed positional target counts.
      const trampoline =
        /^\/bin\/bash --noprofile --norc -p -c export SHELL="\$1"; shift; exec (?:-l )?-- "\$@" orca-tcc-login \S+ (\S+)(?: |$)/.exec(
          loginCommand ?? ''
        )
      const configuredShell =
        trampoline?.[1] ??
        (loginCommand && !loginCommand.includes(' -c ') ? getFirstCommandToken(loginCommand) : '')
      // Only login's direct configured shell is plumbing; an agent's descendant shell never is.
      if (!shell || executable(configuredShell) !== executable(shell.command)) {
        return false
      }
      allowed.add(shell.pid)
    }
    return !tree.some((row) => !allowed.has(row.pid) && !row.stat.includes('Z'))
  } catch {
    return false
  }
}
