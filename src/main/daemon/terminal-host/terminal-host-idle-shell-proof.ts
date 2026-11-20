import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../../shared/shell/command-resolution/command-token-scanner'
import { isShellProcess } from '../../../shared/agent-status/process/shell-process-detection'
import { monotonicNow } from '../../../shared/concurrency/deadline-settle-notifier'
import { getProcessTableIndex } from '../../../shared/process-observation/tables/process-table-index'
import type { ProcessTableRow } from '../../../shared/process-observation/tables/process-table-snapshot'
import type { Session } from '../sessions/session'

/** With job control off a command can share the shell's group, so a full capture re-proves the shell is alone.
 * A same-group run that starts and ends inside one window goes unseen by process polling (hooks still report it). */
export const IDLE_SHELL_PROOF_MAX_AGE_MS = 60_000

type IdleShellProof = { shellPid: number; provedAt: number }

// Keyed by Session so a new session or recycled PID cannot inherit an old proof.
const proofs = new WeakMap<Session, IdleShellProof>()

function commandName(row: ProcessTableRow): string {
  return getCommandTokenPathBasename(getFirstCommandToken(row.command)).replace(/^-/, '')
}

// One pass per capture: every pane's proof then reads its group size by lookup.
const groupSizes = new WeakMap<readonly ProcessTableRow[], ReadonlyMap<number, number>>()

function groupSize(rows: readonly ProcessTableRow[], pgid: number): number {
  let sizes = groupSizes.get(rows)
  if (!sizes) {
    const counted = new Map<number, number>()
    for (const row of rows) {
      if (row.pgid !== undefined) {
        counted.set(row.pgid, (counted.get(row.pgid) ?? 0) + 1)
      }
    }
    groupSizes.set(rows, counted)
    sizes = counted
  }
  return sizes.get(pgid) ?? 0
}

/** Record, from a full capture taken capturedAgeMs ago, whether the pane's shell is alone in the foreground group. */
export function rememberIdleShellProof(
  session: Session,
  rows: readonly ProcessTableRow[],
  capturedAgeMs: number
): void {
  const index = getProcessTableIndex(rows)
  const shell = session.shellIsRootChild
    ? index.childrenByPpid.get(session.pid)?.find((row) => row.pid === row.pgid)
    : index.byPid.get(session.pid)
  if (
    shell !== undefined &&
    shell.tpgid === shell.pid &&
    isShellProcess(commandName(shell)) &&
    groupSize(rows, shell.pid) === 1
  ) {
    proofs.set(session, { shellPid: shell.pid, provedAt: monotonicNow() - capturedAgeMs })
  } else {
    proofs.delete(session)
  }
}

/** The shell's name while a recent full capture proved it alone and its group still owns the terminal. */
export function readProvenIdleShell(session: Session): string | null {
  const proof = proofs.get(session)
  if (!proof || monotonicNow() - proof.provedAt >= IDLE_SHELL_PROOF_MAX_AGE_MS) {
    return null
  }
  const name = session.getForegroundProcess({ rawFallback: true })
  return name && isShellProcess(name) && session.readForegroundGroup() === proof.shellPid
    ? name
    : null
}
