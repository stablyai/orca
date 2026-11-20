import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../../shared/shell/command-resolution/command-token-scanner'
import { isShellProcess } from '../../../shared/agent-status/process/shell-process-detection'
import { monotonicNow } from '../../../shared/concurrency/deadline-settle-notifier'
import { getDarwinProcessGroupSizes } from '../../../shared/process-observation/darwin/darwin-process-group-sizes'
import { getProcessTableIndex } from '../../../shared/process-observation/tables/process-table-index'
import type { ProcessTableRow } from '../../../shared/process-observation/tables/process-table-snapshot'
import { getPaneOccupancy } from '../../providers/foreground/agent-process-batch'
import type { Session } from '../sessions/session'

/** A full capture re-proves the shell is alone this often; polls in between re-count its group from a cheap read. */
const IDLE_SHELL_PROOF_MAX_AGE_MS = 60_000

type IdleShellProof = { shellPid: number; provedAt: number; outputChunks: number }

// Keyed by Session so a new session or recycled PID cannot inherit an old proof.
const proofs = new WeakMap<Session, IdleShellProof>()

function commandName(row: ProcessTableRow): string {
  return getCommandTokenPathBasename(getFirstCommandToken(row.command)).replace(/^-/, '')
}

/** Record, from a full capture taken capturedAgeMs ago, whether the pane's shell is alone in the foreground group.
 * outputChunks is the pane's count read before the capture was requested, so later output voids the proof. */
export function rememberIdleShellProof(
  session: Session,
  rows: readonly ProcessTableRow[],
  capturedAgeMs: number,
  outputChunks: number
): void {
  const index = getProcessTableIndex(rows)
  const shell = session.shellIsRootChild
    ? index.childrenByPpid.get(session.pid)?.find((row) => row.pid === row.pgid)
    : index.byPid.get(session.pid)
  const groups = getPaneOccupancy(rows)
  if (
    shell !== undefined &&
    shell.tpgid === shell.pid &&
    isShellProcess(commandName(shell)) &&
    !groups.processGroupsIncomplete &&
    groups.rowsByProcessGroup.get(shell.pid) === 1
  ) {
    proofs.set(session, {
      shellPid: shell.pid,
      provedAt: monotonicNow() - capturedAgeMs,
      outputChunks
    })
  } else {
    proofs.delete(session)
  }
}

function proofHolds(session: Session, proof: IdleShellProof): string | null {
  if (
    !session.isAlive ||
    monotonicNow() - proof.provedAt >= IDLE_SHELL_PROOF_MAX_AGE_MS ||
    session.outputChunks !== proof.outputChunks
  ) {
    return null
  }
  const name = session.getForegroundProcess({ rawFallback: true })
  return name && isShellProcess(name) && session.readForegroundGroup() === proof.shellPid
    ? name
    : null
}

/** The shell's name while a recent full capture proved it alone, its group still owns the terminal, and the group
 * still holds only the shell (job control off lets a silent command join it). */
export async function readProvenIdleShell(session: Session): Promise<string | null> {
  const proof = proofs.get(session)
  if (!proof || proofHolds(session, proof) === null) {
    return null
  }
  try {
    if ((await getDarwinProcessGroupSizes()).get(proof.shellPid) !== 1) {
      return null
    }
  } catch {
    return null
  }
  // Re-read after the await: output or a new foreground job may have arrived meanwhile.
  return proofHolds(session, proof)
}
