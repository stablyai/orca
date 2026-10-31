/**
 * Recovery for an interrupted WSL move: back to zero, or forward when the destination committed.
 *
 * The commit point is the destination's durable `commitCatalog` acknowledgement. The desktop may
 * ask for it only once the journal says `blobs-transferred`, so a record short of that phase cannot
 * have a commit behind it: it resets without the host. Only `blobs-transferred` needs the host's
 * catalog state to decide, and stays fenced while that is unknown. Source rows are never rewritten
 * before commit, so lifting the record is the whole reset; a host's leftover staging expires.
 */
import type {
  OrcadMigrationCatalogReferenceAbortResult,
  OrcadMigrationCatalogState
} from '../../../shared/orcad-migration/orcad-migration-manifest'
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
import { orcadMigrationRequestFits } from '../../ssh/orcad-migration-manifest-export'
import { wslHostsServing } from '../../wsl/wsl-host-gate'
import {
  listWslMoveCutovers,
  removeUncommittedWslMoveCutover,
  writeWslMoveCutover
} from './wsl-move-cutover-journal'
import { recordWslMoveOwedHostAbort } from './wsl-move-owed-host-aborts'

/** The only phase from which the desktop may ask the destination to commit. */
export const WSL_MOVE_COMMIT_REQUEST_PHASE: WslMoveCutoverPhase = 'blobs-transferred'

/** A move driver calls this right before `commitCatalog`; recovery relies on it. */
export function assertWslMoveCommitRequestAllowed(cutover: Pick<WslMoveCutover, 'phase'>): void {
  if (cutover.phase !== WSL_MOVE_COMMIT_REQUEST_PHASE) {
    throw new Error('wsl_move_commit_before_blobs_transferred')
  }
}

export type WslMoveResetResult =
  | {
      outcome: 'reset'
      evidence: 'no-record' | 'commit-never-requested' | 'catalog-absent' | 'distro-unregistered'
    }
  | { outcome: 'committed'; cutover: WslMoveCutover }
  | { outcome: 'unverifiable'; reason: string }

export type WslMoveResetContext = {
  userDataPath: string
  /** The WSL host's catalog; null while it is unreachable. */
  destination: OrcadMigrationDestinationCatalog | null
  /**
   * The distro is proven unregistered (name and recorded GUID gone): its disk, and any commit on
   * it, went too. Residual: an unregister then re-import under a new name between two startups.
   */
  destinationUnregistered?: boolean
  now?: () => Date
}

const phaseIndex = (phase: WslMoveCutoverPhase): number => WSL_MOVE_CUTOVER_PHASES.indexOf(phase)
const COMMITTED_FROM = phaseIndex('destination-committed')
// The stage request goes out from `quiesced`, so from there the host may hold one.
const STAGE_MAY_EXIST_FROM = phaseIndex('quiesced')

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
  const release = (
    evidence: 'commit-never-requested' | 'catalog-absent' | 'distro-unregistered',
    hostConfirmedAbsent = false
  ): WslMoveResetResult => {
    if (!hostConfirmedAbsent && phaseIndex(cutover.phase) >= STAGE_MAY_EXIST_FROM) {
      recordWslMoveOwedHostAbort(context.userDataPath, cutover)
    }
    removeUncommittedWslMoveCutover(context.userDataPath, migrationId)
    return { outcome: 'reset', evidence }
  }
  if (!context.destination) {
    if (context.destinationUnregistered) {
      return release('distro-unregistered', true)
    }
    return commitMayExist
      ? { outcome: 'unverifiable', reason: 'destination_unreachable' }
      : release('commit-never-requested')
  }
  const destination = context.destination
  const byReference = () =>
    resetByReference({ ...context, destination }, cutover, commitMayExist, release)
  if (!orcadMigrationRequestFits({ manifest: cutover.manifest })) {
    return byReference()
  }
  let state: OrcadMigrationCatalogState
  try {
    state = await destination.readState(cutover.manifest)
    if (state.state !== 'committed') {
      state = await abortWithRecovery(destination, cutover.manifest)
    }
  } catch {
    // A host with a lower request limit refuses even a manifest this build sizes as fitting.
    return commitMayExist ? byReference() : release('commit-never-requested')
  }
  if (state.state === 'absent') {
    return release(commitMayExist ? 'catalog-absent' : 'commit-never-requested', true)
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

/**
 * A manifest too large for any request cannot be read or aborted inline, so the host is asked by
 * its identity alone; without this a reset could never prove the host empty and would stay stuck.
 */
async function resetByReference(
  context: WslMoveResetContext & { destination: OrcadMigrationDestinationCatalog },
  cutover: WslMoveCutover,
  commitMayExist: boolean,
  release: (
    evidence: 'commit-never-requested' | 'catalog-absent',
    hostConfirmedAbsent?: boolean
  ) => WslMoveResetResult
): Promise<WslMoveResetResult> {
  let aborted: OrcadMigrationCatalogReferenceAbortResult
  try {
    aborted = await context.destination.abortByReference(cutover.manifest)
  } catch (error) {
    return commitMayExist
      ? { outcome: 'unverifiable', reason: describe(error) }
      : release('commit-never-requested')
  }
  if (aborted.state === 'absent') {
    return release(commitMayExist ? 'catalog-absent' : 'commit-never-requested', true)
  }
  if (!commitMayExist) {
    return { outcome: 'unverifiable', reason: 'committed_without_commit_request' }
  }
  // commit() cannot carry this manifest; only a receipt the host flushed before answering counts.
  if (aborted.durableCommitted !== true) {
    return { outcome: 'unverifiable', reason: 'commit_not_proven_durable' }
  }
  return { outcome: 'committed', cutover: recordCommitted(context, cutover) }
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
  return recordCommitted(context, cutover)
}

function recordCommitted(context: WslMoveResetContext, cutover: WslMoveCutover): WslMoveCutover {
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
  warn: (message: string) => void = (message) => console.warn(message),
  /** Asked only for a move that may have committed; one whose distro is gone resets too. */
  isDistroRegistered?: (distro: string, distroGuid?: string) => Promise<boolean | null>
): Promise<WslMoveStartupRecovery> {
  const result: WslMoveStartupRecovery = { reset: [], waitingForHost: [] }
  if (!wslHostsServing()) {
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
      const destinationUnregistered =
        cutover.phase === WSL_MOVE_COMMIT_REQUEST_PHASE && isDistroRegistered
          ? (await isDistroRegistered(
              cutover.manifest.source.distro,
              cutover.manifest.source.distroGuid
            ).catch(() => null)) === false
          : false
      const outcome = await resetWslMoveToZero(
        { userDataPath, destination: null, destinationUnregistered },
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
