import { createDispatchCreatorEvaluation } from './dispatch-creator-evaluation'
import { requireOrchestrationAdmission } from '../orchestration-admission'
export { isSelfCreatedDispatch, AmbiguousDispatchParentError } from './dispatch-creator-evaluation'
import type { OrchestrationDb } from './orchestration-db'
import type { OrcaSessionId } from '../../../../shared/orca-session-address'
import type { DispatchContextRow, RemoteDispatchAttachmentRow } from '../types'
import { potentiallyLiveRemoteAttachmentSql } from './federation/remote-attachment-liveness'
import {
  DISPATCH_CONTEXT_COLUMN_LIST,
  REMOTE_DISPATCH_ATTACHMENT_COLUMN_LIST
} from './row-column-lists'

/** The system root is internal host-local coordinator code; never let callers select it to bypass depth. */
export type DispatchCreator =
  | { kind: 'system' }
  | {
      kind: 'terminal'
      handle: string
      paneKey?: string
      /** Remote attachment matching requires the exact incarnation; local rows do not. */
      processIncarnation?: string
      /** A structured worker's bare Orca session id, recorded beside its handle. */
      orcaSessionId?: OrcaSessionId | null
    }
  /** A structured session with no terminal handle, identified by its Orca session id alone. */
  | { kind: 'session'; orcaSessionId: OrcaSessionId }

/** Creator identity to persist on a new row, so depth can later tell delegation from bookkeeping. */
export function recordedCreatorIdentity(creator: DispatchCreator): {
  creatorHandle: string | null
  creatorPaneKey: string | null
  creatorOrcaSessionId: OrcaSessionId | null
} {
  if (creator.kind === 'system') {
    return { creatorHandle: null, creatorPaneKey: null, creatorOrcaSessionId: null }
  }
  if (creator.kind === 'session') {
    return {
      creatorHandle: null,
      creatorPaneKey: null,
      creatorOrcaSessionId: creator.orcaSessionId
    }
  }
  return {
    creatorHandle: creator.handle,
    creatorPaneKey: creator.paneKey ?? null,
    creatorOrcaSessionId: creator.orcaSessionId ?? null
  }
}

/** The live Dispatch this creator is itself working on, found the way its identity is recorded. */
function findActiveDispatchForCreator(
  this: OrchestrationDb,
  creator: Exclude<DispatchCreator, { kind: 'system' }>
): DispatchContextRow | undefined {
  if (creator.kind === 'terminal') {
    return this.findActiveDispatchForAssignee(creator.handle, creator.paneKey)
  }
  const row = this.db
    .prepare(
      `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
       WHERE assignee_orca_session_id = ? AND status IN ('pending', 'dispatched')
       ORDER BY rowid DESC LIMIT 1`
    )
    .get(creator.orcaSessionId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The schema-pinned complete Dispatch projection returns one Dispatch row or undefined; the adapter exposes unknown.
  return row as DispatchContextRow | undefined
}

/** Match pane and exact incarnation; stored remote handles can lag a remint. */
function findPotentiallyLiveAttachmentsForCreator(
  this: OrchestrationDb,
  creator: Extract<DispatchCreator, { kind: 'terminal' }>
): RemoteDispatchAttachmentRow[] {
  if (!creator.paneKey || !creator.processIncarnation) {
    return []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The schema-pinned attachment projection returns RemoteDispatchAttachmentRow rows; the adapter exposes unknown.
  const rows = this.db
    .prepare(
      `SELECT ${REMOTE_DISPATCH_ATTACHMENT_COLUMN_LIST} FROM remote_dispatch_attachments
       WHERE process_incarnation = ?
         AND pane_key IS NOT NULL
         AND ${potentiallyLiveRemoteAttachmentSql()}`
    )
    .all(creator.processIncarnation) as RemoteDispatchAttachmentRow[]

  return rows
}

export function resolveCreatorDepth(this: OrchestrationDb, creator: DispatchCreator): number {
  return (
    requireOrchestrationAdmission(
      liveDispatchCreatorEvaluation(this, creator).childDepth(Infinity)
    ) - 1
  )
}
export function resolveCreatorDispatchId(
  this: OrchestrationDb,
  creator: DispatchCreator
): string | null {
  return requireOrchestrationAdmission(liveDispatchCreatorEvaluation(this, creator).creatorId())
}
export function resolveChildDispatchDepth(
  this: OrchestrationDb,
  creator: DispatchCreator,
  maxDepth: number
): number {
  return requireOrchestrationAdmission(
    liveDispatchCreatorEvaluation(this, creator).childDepth(maxDepth)
  )
}
export function liveDispatchCreatorEvaluation(db: OrchestrationDb, creator: DispatchCreator) {
  return createDispatchCreatorEvaluation(creator, {
    local: () =>
      creator.kind === 'system' ? undefined : findActiveDispatchForCreator.call(db, creator),
    remote: () =>
      creator.kind === 'terminal' ? findPotentiallyLiveAttachmentsForCreator.call(db, creator) : []
  })
}

export type DispatchDepthMethods = {
  resolveCreatorDepth: typeof resolveCreatorDepth
  resolveCreatorDispatchId: typeof resolveCreatorDispatchId
  resolveChildDispatchDepth: typeof resolveChildDispatchDepth
}

export function attachDispatchDepth(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    resolveCreatorDepth,
    resolveCreatorDispatchId,
    resolveChildDispatchDepth
  })
}
