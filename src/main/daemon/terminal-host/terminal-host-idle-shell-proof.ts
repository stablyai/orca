import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../../shared/shell/command-resolution/command-token-scanner'
import { isShellProcess } from '../../../shared/agent-status/process/shell-process-detection'
import { monotonicNow } from '../../../shared/concurrency/deadline-settle-notifier'
import { readDarwinProcessGroupSizes } from '../../../shared/process-observation/darwin/darwin-process-group-sizes'
import {
  createProcessTableSnapshotReader,
  peekStrictProcessTableSnapshot,
  withEvidenceBudget
} from '../../../shared/process-observation/tables/process-table-snapshot-reader'
import { getProcessTableIndex } from '../../../shared/process-observation/tables/process-table-index'
import {
  ProcessTableCaptureError,
  type ProcessTableRow
} from '../../../shared/process-observation/tables/process-table-snapshot'
import { getPaneOccupancy } from '../../providers/foreground/agent-process-batch'
import type { Session } from '../sessions/session'

/** A full capture re-proves the shell is alone this often; polls in between re-count its group from a cheap read. */
const IDLE_SHELL_PROOF_MAX_AGE_MS = 60_000

/** childless: the shell also had no child process, so the pane may stop re-checking; otherwise the proof only
 * lets re-checks stay cheap, as before. */
type IdleShellProof = { shellPid: number; provedAt: number; activity: number; childless: boolean }

// Keyed by Session so a new session or recycled PID cannot inherit an old proof.
const proofs = new WeakMap<Session, IdleShellProof>()

/** Group sizes for a round: from a full capture another pane's poll already needs, else one kinfo-only read. */
const groupSizesReader = createProcessTableSnapshotReader<ReadonlyMap<number, number>>({
  runPs: async () => {
    // Requests delivered in the same socket read run first, so a full capture one of them starts serves the rest.
    await new Promise((resolve) => setImmediate(resolve))
    const full = peekStrictProcessTableSnapshot()
    if (!full) {
      return readDarwinProcessGroupSizes()
    }
    const groups = getPaneOccupancy(await full)
    if (groups.processGroupsIncomplete) {
      throw new ProcessTableCaptureError('process_groups_incomplete')
    }
    return groups.rowsByProcessGroup
  },
  now: () => Date.now()
})

/** Output and input the pane has seen; either one after a proof may have started work the proof cannot vouch for. */
export function paneActivity(session: Pick<Session, 'outputChunks' | 'inputWrites'>): number {
  return session.outputChunks + session.inputWrites
}

function commandName(row: ProcessTableRow): string {
  return getCommandTokenPathBasename(getFirstCommandToken(row.command)).replace(/^-/, '')
}

/** Record, from a full capture taken capturedAgeMs ago, whether the pane's shell is alone in its foreground group, and
 * return whether it is also idle: no child process at all. activity is the pane's paneActivity read before the capture
 * was requested, so later activity voids the proof. */
export function rememberIdleShellProof(
  session: Session,
  rows: readonly ProcessTableRow[],
  capturedAgeMs: number,
  activity: number,
  /** False when the capture may predate the pane's latest activity: it still keeps re-checks cheap, but proves nothing idle. */
  capturedAfterActivity = true
): boolean {
  const name = session.getForegroundProcess({ rawFallback: true })
  if (!name || !isShellProcess(name)) {
    proofs.delete(session)
    return false
  }
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
    // Any child (a background or stopped job, a setsid child it waits on) may be followed by an agent.
    const childless =
      capturedAfterActivity &&
      (index.childrenByPpid.get(shell.pid)?.length ?? 0) === 0 &&
      onlyLaunchGroupsOnTerminal(shell, index, groups)
    proofs.set(session, {
      shellPid: shell.pid,
      provedAt: monotonicNow() - capturedAgeMs,
      activity,
      childless
    })
    return childless
  }
  proofs.delete(session)
  return false
}

/** Other groups on the terminal may be work the shell waits on (a reparented double fork); its launch wrappers are not. */
function onlyLaunchGroupsOnTerminal(
  shell: ProcessTableRow,
  index: ReturnType<typeof getProcessTableIndex>,
  groups: ReturnType<typeof getPaneOccupancy>
): boolean {
  if (shell.tpgid === undefined || groups.stoppedTtys.has(shell.tpgid)) {
    return false
  }
  const launchGroups = new Set([shell.pid])
  const seen = new Set<number>()
  for (
    let row = index.byPid.get(shell.ppid);
    row && !seen.has(row.pid);
    row = index.byPid.get(row.ppid)
  ) {
    seen.add(row.pid)
    if (row.pgid !== undefined) {
      launchGroups.add(row.pgid)
    }
  }
  return [...(groups.processGroupsByTty.get(shell.tpgid) ?? [])].every((group) =>
    launchGroups.has(group)
  )
}

function provenShellName(
  session: Session,
  proof: IdleShellProof,
  isCurrent: () => boolean
): string | null {
  if (
    !session.isAlive ||
    !isCurrent() ||
    monotonicNow() - proof.provedAt >= IDLE_SHELL_PROOF_MAX_AGE_MS ||
    paneActivity(session) !== proof.activity
  ) {
    return null
  }
  const name = session.getForegroundProcess({ rawFallback: true })
  return name && isShellProcess(name) && session.readForegroundGroup() === proof.shellPid
    ? name
    : null
}

/** The shell's name while a recent full capture proved it alone, its group still owns the terminal, and the group
 * still holds only the shell (job control off lets a silent command join it); idle when that capture found no child. */
export async function readProvenIdleShell(
  session: Session,
  isCurrent: () => boolean
): Promise<{ name: string; idle: boolean } | null> {
  const proof = proofs.get(session)
  if (!proof || provenShellName(session, proof, isCurrent) === null) {
    return null
  }
  try {
    if ((await withEvidenceBudget(groupSizesReader.getSnapshot())).get(proof.shellPid) !== 1) {
      return null
    }
  } catch {
    return null
  }
  // Re-read after the await: output or a new foreground job may have arrived meanwhile.
  const name = provenShellName(session, proof, isCurrent)
  return name === null ? null : { name, idle: proof.childless }
}
