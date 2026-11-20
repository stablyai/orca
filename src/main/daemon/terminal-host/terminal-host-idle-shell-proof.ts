import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../../shared/shell/command-resolution/command-token-scanner'
import { isShellProcess } from '../../../shared/agent-status/process/shell-process-detection'
import type { ProcessTableRow } from '../../../shared/process-observation/tables/process-table-snapshot'
import type { Session } from '../sessions/session'

/** With job control off a command can share the shell's group, so a full capture re-proves the shell is alone. */
export const IDLE_SHELL_PROOF_MAX_AGE_MS = 60_000

type IdleShellProof = { shellPid: number; provedAt: number }

// Keyed by Session so a new session or recycled PID cannot inherit an old proof.
const proofs = new WeakMap<Session, IdleShellProof>()

function commandName(row: ProcessTableRow): string {
  return getCommandTokenPathBasename(getFirstCommandToken(row.command)).replace(/^-/, '')
}

/** Record, from a full capture, whether the pane's shell is alone in the foreground group. */
export function rememberIdleShellProof(
  session: Session,
  rows: readonly ProcessTableRow[],
  now: number
): void {
  const shell = session.shellIsRootChild
    ? rows.find((row) => row.ppid === session.pid && row.pid === row.pgid)
    : rows.find((row) => row.pid === session.pid)
  const alone =
    shell !== undefined &&
    shell.tpgid === shell.pid &&
    isShellProcess(commandName(shell)) &&
    rows.every((row) => row.pgid !== shell.pid || row.pid === shell.pid)
  if (alone) {
    proofs.set(session, { shellPid: shell.pid, provedAt: now })
  } else {
    proofs.delete(session)
  }
}

/** The shell's name while a recent full capture proved it alone and its group still owns the terminal. */
export function readProvenIdleShell(session: Session, now: number): string | null {
  const proof = proofs.get(session)
  if (!proof || now - proof.provedAt >= IDLE_SHELL_PROOF_MAX_AGE_MS) {
    return null
  }
  const name = session.getForegroundProcess({ rawFallback: true })
  return name && isShellProcess(name) && session.readForegroundGroup() === proof.shellPid
    ? name
    : null
}
