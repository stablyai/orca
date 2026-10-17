/**
 * Recovery for an interrupted WSL move: back to zero, or forward when the destination committed.
 *
 * The commit point is the destination's durable `commitCatalog` acknowledgement. The desktop may
 * ask for it only once the journal says `blobs-transferred`, so a record short of that phase cannot
 * have a commit behind it: it resets without the host. Only `blobs-transferred` needs the host's
 * catalog state to decide, and stays fenced while that is unknown. Source rows are never rewritten
 * before commit, so lifting the record is the whole reset; a host's leftover staging expires.
 */
import type { OrcadMigrationCatalogState } from '../../../shared/orcad-migration-manifest'
import {
  WSL_MOVE_CUTOVER_PHASES,
  type WslMoveCutover,
  type WslMoveCutoverPhase
} from '../../../shared/wsl-move/wsl-move-cutover'
import {
  abortWithRecovery,
  confirmDurableCommit,
  type OrcadMigrationDestinationCatalog
} from '../../ssh/orcad-migration-cutover-coordinator'
import { wslHostsGateOpen } from '../../wsl/wsl-host-gate'
import {
  listWslMoveCutovers,
  removeUncommittedWslMoveCutover,
  writeWslMoveCutover
} from './wsl-move-cutover-journal'

/** The only phase from which the desktop may ask the destination to commit. */
export const WSL_MOVE_COMMIT_REQUEST_PHASE: WslMoveCutoverPhase = 'blobs-transferred'

/** A move driver calls this right before `commitCatalog`; recovery relies on it. */
export function assertWslMoveCommitRequestAllowed(cutover: Pick<WslMoveCutover, 'phase'>): void {
  if (cutover.phase !== WSL_MOVE_COMMIT_REQUEST_PHASE) {
    throw new Error('wsl_move_commit_before_blobs_transferred')
  }
}

export type WslMoveResetResult =
  | { outcome: 'reset'; evidence: 'no-record' | 'commit-never-requested' | 'catalog-absent' }
  | { outcome: 'committed'; cutover: WslMoveCutover }
  | { outcome: 'unverifiable'; reason: string }

export type WslMoveResetContext = {
  userDataPath: string
  /** The WSL host's catalog; null while it is unreachable. */
  destination: OrcadMigrationDestinationCatalog | null
  now?: () => Date
}

const phaseIndex = (phase: WslMoveCutoverPhase): number => WSL_MOVE_CUTOVER_PHASES.indexOf(phase)
const COMMITTED_FROM = phaseIndex('destination-committed')

export async function resetWslMoveToZero(
  context: WslMoveResetContext,
  migrationId: string
): Promise<WslMoveResetResult> {
  const cutover = listWslMoveCutovers(context.userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (!cutover) {
    return { outcome: 'reset', evidence: 'no-record' }
  }
  if (phaseIndex(cutover.phase) >= COMMITTED_FROM) {
    return { outcome: 'committed', cutover }
  }
  const commitMayExist = cutover.phase === WSL_MOVE_COMMIT_REQUEST_PHASE
  const release = (evidence: 'commit-never-requested' | 'catalog-absent'): WslMoveResetResult => {
    removeUncommittedWslMoveCutover(context.userDataPath, migrationId)
    return { outcome: 'reset', evidence }
  }
  if (!context.destination) {
    return commitMayExist
      ? { outcome: 'unverifiable', reason: 'destination_unreachable' }
      : release('commit-never-requested')
  }
  let state: OrcadMigrationCatalogState
  try {
    state = await context.destination.readState(cutover.manifest)
    if (state.state !== 'committed') {
      state = await abortWithRecovery(context.destination, cutover.manifest)
    }
  } catch (error) {
    return commitMayExist
      ? { outcome: 'unverifiable', reason: describe(error) }
      : release('commit-never-requested')
  }
  if (state.state === 'absent') {
    return release(commitMayExist ? 'catalog-absent' : 'commit-never-requested')
  }
  if (state.state !== 'committed') {
    return { outcome: 'unverifiable', reason: `catalog_${state.state}` }
  }
  if (!commitMayExist) {
    // A commit no request could have made: keep the fence rather than guess which side owns it.
    return { outcome: 'unverifiable', reason: 'committed_without_commit_request' }
  }
  return { outcome: 'committed', cutover: await recordCommit(context, cutover) }
}

/** Only commit()'s acknowledgement, which flushes first, may move the journal to committed. */
async function recordCommit(
  context: WslMoveResetContext,
  cutover: WslMoveCutover
): Promise<WslMoveCutover> {
  if (!context.destination) {
    throw new Error('wsl_move_destination_unreachable')
  }
  const state = await confirmDurableCommit(context.destination, cutover.manifest)
  if (
    state.state !== 'committed' ||
    state.migrationId !== cutover.migrationId ||
    state.manifestSha256 !== cutover.manifestSha256 ||
    state.receipt.migrationId !== cutover.migrationId ||
    state.receipt.manifestSha256 !== cutover.manifestSha256
  ) {
    throw new Error('wsl_move_destination_state_mismatch')
  }
  const committed: WslMoveCutover = {
    ...cutover,
    phase: 'destination-committed',
    updatedAt: (context.now ?? (() => new Date()))().toISOString()
  }
  writeWslMoveCutover(context.userDataPath, committed)
  return committed
}

export type WslMoveStartupRecovery = {
  reset: string[]
  /** `blobs-transferred` with no host to ask: still fenced until the host answers. */
  waitingForHost: string[]
}

/**
 * Startup, before anything can start a move: every interrupted move short of commit resets, except
 * one that may have committed, which waits for its host. A no-op unless the WSL hosts gate is open.
 */
export async function recoverInterruptedWslMoves(
  userDataPath: string,
  warn: (message: string) => void = (message) => console.warn(message)
): Promise<WslMoveStartupRecovery> {
  const result: WslMoveStartupRecovery = { reset: [], waitingForHost: [] }
  if (!wslHostsGateOpen()) {
    return result
  }
  let inFlight: WslMoveCutover[]
  try {
    inFlight = listWslMoveCutovers(userDataPath).filter(
      (cutover) => phaseIndex(cutover.phase) < COMMITTED_FROM
    )
  } catch (error) {
    // Unreadable journal: every WSL project stays fenced (scope guard); nothing to reset safely.
    warn(`[wsl-move] Could not read the move journal for recovery: ${describe(error)}`)
    return result
  }
  for (const cutover of inFlight) {
    try {
      const outcome = await resetWslMoveToZero(
        { userDataPath, destination: null },
        cutover.migrationId
      )
      if (outcome.outcome === 'reset') {
        result.reset.push(cutover.migrationId)
      } else {
        result.waitingForHost.push(cutover.migrationId)
      }
    } catch (error) {
      warn(`[wsl-move] Could not reset interrupted move ${cutover.migrationId}: ${describe(error)}`)
    }
  }
  return result
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
