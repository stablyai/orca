/**
 * The orchestrator's transitions for what happens outside a move step: the user's choices
 * (Retry, Not now, a release, a host Add or Remove), R38 distro verdicts, and startup settling.
 */
import type {
  WslMoveOrchestratorRecord,
  WslMoveOrchestratorUserAction
} from '../../../shared/wsl-move/wsl-move-orchestrator-types'
import {
  WSL_MOVE_ORCHESTRATOR_NOT_NOW_MS,
  withWslMoveOrchestratorState
} from './wsl-move-orchestrator-transitions'

/** Whether a finished move's distro is still the one it moved into (R38). */
export type WslMovedDistroVerdict =
  | 'present'
  /** Neither its name nor its recorded GUID is registered. */
  | 'gone'
  /** The host lists none of the moved projects (needs the host-catalog check). */
  | 'replaced'
  /** The registry or host could not be read, or only the GUID differs; nothing is concluded. */
  | 'unknown'

export function applyWslMovedDistroVerdict(
  record: WslMoveOrchestratorRecord,
  verdict: WslMovedDistroVerdict,
  now: number
): WslMoveOrchestratorRecord {
  switch (verdict) {
    case 'gone':
      return withWslMoveOrchestratorState(record, { kind: 'distro-gone' }, now)
    case 'replaced':
      return withWslMoveOrchestratorState(record, { kind: 'restore-offered' }, now)
    case 'present':
      // A distro registered again, or whose host still has the projects, is back.
      return record.state.kind === 'distro-gone' || record.state.kind === 'restore-offered'
        ? withWslMoveOrchestratorState(record, { kind: 'pending' }, now)
        : record
    case 'unknown':
      return record
  }
}

/** The record after a user action; `restore` applies only once the release succeeded. */
export function applyWslMoveUserAction(
  record: WslMoveOrchestratorRecord,
  action: WslMoveOrchestratorUserAction,
  now: number,
  appVersion: string
): WslMoveOrchestratorRecord {
  if (record.state.kind === 'moving') {
    return record
  }
  if (action === 'not-now') {
    return withWslMoveOrchestratorState(
      record,
      { kind: 'parked', reason: 'not-now', until: now + WSL_MOVE_ORCHESTRATOR_NOT_NOW_MS },
      now
    )
  }
  return withWslMoveOrchestratorState(record, { kind: 'pending' }, now, { attempts: 0, appVersion })
}

/** "Use on this computer again" is the user saying no: nothing moves the distro until Retry. */
export function applyWslMoveReleasedByUser(
  record: WslMoveOrchestratorRecord,
  now: number
): WslMoveOrchestratorRecord {
  return withWslMoveOrchestratorState(record, { kind: 'parked', reason: 'declined' }, now)
}

/** The user added the host themselves: a decline (theirs, by Remove or release) is taken back. */
export function applyWslMoveHostAddedByUser(
  record: WslMoveOrchestratorRecord,
  now: number
): WslMoveOrchestratorRecord {
  return record.state.kind === 'parked' && record.state.reason === 'declined'
    ? withWslMoveOrchestratorState(record, { kind: 'pending' }, now)
    : record
}

/** A host whose Remove is unfinished is the user's to settle; park the distro until they act. */
export function applyWslMoveHostRemovalPending(
  record: WslMoveOrchestratorRecord,
  now: number
): WslMoveOrchestratorRecord {
  return withWslMoveOrchestratorState(record, { kind: 'parked', reason: 'removal-pending' }, now)
}

/** The pending Remove settled: a kept host resumes, a removed one stays the user's decline. */
export function applyWslMoveHostRemovalSettled(
  record: WslMoveOrchestratorRecord,
  hostKept: boolean,
  now: number
): WslMoveOrchestratorRecord {
  return withWslMoveOrchestratorState(
    record,
    hostKept ? { kind: 'pending' } : { kind: 'parked', reason: 'declined' },
    now
  )
}

/** A record read at startup, made true to what survived the last process. */
export function settleWslMoveOrchestratorRecord(
  record: WslMoveOrchestratorRecord,
  now: number,
  hasFinishedMove: boolean
): WslMoveOrchestratorRecord {
  // The driver's own startup recovery resumes or resets the journal; the next trigger previews.
  if (record.state.kind === 'moving') {
    return withWslMoveOrchestratorState(record, { kind: 'pending' }, now)
  }
  // A Restore that released the move before the app quit has nothing left to restore.
  return record.state.kind === 'restore-offered' && !hasFinishedMove
    ? withWslMoveOrchestratorState(record, { kind: 'pending' }, now)
    : record
}
