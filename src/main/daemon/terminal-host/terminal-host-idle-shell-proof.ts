import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../../shared/shell/command-resolution/command-token-scanner'
import { isShellProcess } from '../../../shared/agent-status/process/shell-process-detection'
import { monotonicNow } from '../../../shared/concurrency/deadline-settle-notifier'
import { countLibprocProcessGroup } from '../../../shared/process-observation/darwin/libproc-addon'
import { getProcessTableIndex } from '../../../shared/process-observation/tables/process-table-index'
import type { ProcessTableRow } from '../../../shared/process-observation/tables/process-table-snapshot'
import type { Session } from '../sessions/session'

/** A full capture re-proves the shell is alone this often; every poll in between re-counts its group exactly. */
export const IDLE_SHELL_PROOF_MAX_AGE_MS = 60_000
// Each group count walks the kernel's process list on this thread; past this rate the shared capture is cheaper.
const GROUP_COUNTS_PER_SECOND = 50

type IdleShellProof = { shellPid: number; provedAt: number; outputChunks: number }

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

/** Record, from a full capture taken capturedAgeMs ago, whether the pane's shell is alone in the foreground group.
 * The output count must have been read (at countedAt) before the capture began, or output could predate the rows. */
export function rememberIdleShellProof(
  session: Session,
  rows: readonly ProcessTableRow[],
  capturedAgeMs: number,
  output: { chunks: number; countedAt: number }
): void {
  const capturedAt = monotonicNow() - capturedAgeMs
  const index = getProcessTableIndex(rows)
  const shell = session.shellIsRootChild
    ? index.childrenByPpid.get(session.pid)?.find((row) => row.pid === row.pgid)
    : index.byPid.get(session.pid)
  if (
    capturedAt >= output.countedAt &&
    shell !== undefined &&
    shell.tpgid === shell.pid &&
    isShellProcess(commandName(shell)) &&
    groupSize(rows, shell.pid) === 1
  ) {
    proofs.set(session, {
      shellPid: shell.pid,
      provedAt: capturedAt,
      outputChunks: output.chunks
    })
  } else {
    proofs.delete(session)
  }
}

let groupCountWindowStart = Number.NEGATIVE_INFINITY
let groupCountsInWindow = 0

function takeGroupCount(now: number): boolean {
  if (now - groupCountWindowStart >= 1_000) {
    groupCountWindowStart = now
    groupCountsInWindow = 0
  }
  groupCountsInWindow += 1
  return groupCountsInWindow <= GROUP_COUNTS_PER_SECOND
}

/** The shell's name while a recent full capture proved it alone, its group still owns the terminal, and the group
 * still holds only the shell (job control off lets a silent command join it). */
export function readProvenIdleShell(session: Session): string | null {
  const proof = proofs.get(session)
  const now = monotonicNow()
  if (
    !proof ||
    now - proof.provedAt >= IDLE_SHELL_PROOF_MAX_AGE_MS ||
    session.outputChunks !== proof.outputChunks
  ) {
    return null
  }
  const name = session.getForegroundProcess({ rawFallback: true })
  if (!name || !isShellProcess(name) || session.readForegroundGroup() !== proof.shellPid) {
    return null
  }
  return takeGroupCount(now) && countLibprocProcessGroup(proof.shellPid) === 1 ? name : null
}
