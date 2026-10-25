import {
  NESTED_WORKER_DEPTH_EXCEEDED_CODE,
  NESTED_WORKER_DEPTH_EXCEEDED_NEXT_STEPS,
  ROOT_DISPATCH_DEPTH,
  nestedWorkerDepthExceededMessage
} from '../../../../shared/nested-worker-depth'
import { OrchestrationError } from '../orchestration-error'
import { isEquivalentPaneKey } from './pane-key-match'
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

/** Self-dispatch is bookkeeping; pre-v37 rows lack creator identity and conservatively count as parents. */
function isSelfCreatedDispatch(row: DispatchContextRow): boolean {
  if (row.creator_pane_key && row.assignee_pane_key) {
    return isEquivalentPaneKey(row.creator_pane_key, row.assignee_pane_key)
  }
  return row.creator_handle != null && row.creator_handle === row.assignee_handle
}

/** Unknown start/stop outcomes cannot prove exit; count them as parents (docs/reference/ssh-execution-boundary.md). */
export class AmbiguousDispatchParentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AmbiguousDispatchParentError'
  }
}

/** Use the deepest live role: concurrent local and remote assignments must never undercount caller depth. */
export function resolveCreatorDepth(this: OrchestrationDb, creator: DispatchCreator): number {
  if (creator.kind === 'system') {
    return ROOT_DISPATCH_DEPTH
  }

  const depths: number[] = []

  // Local context-only rows may lack incarnation; handle/pane identity must still count the parent.
  const local = findActiveDispatchForCreator.call(this, creator)
  if (local && !isSelfCreatedDispatch(local)) {
    depths.push(local.depth)
  }

  const attachments =
    creator.kind === 'terminal' ? findPotentiallyLiveAttachmentsForCreator.call(this, creator) : []
  for (const attachment of attachments) {
    depths.push(attachment.depth)
  }

  return depths.length > 0 ? Math.max(...depths) : ROOT_DISPATCH_DEPTH
}

/** Proven creator Attempt or null; multiple live matching remote attachments throw. */
export function resolveCreatorDispatchId(
  this: OrchestrationDb,
  creator: DispatchCreator
): string | null {
  if (creator.kind === 'system') {
    return null
  }
  const own = findActiveDispatchForCreator.call(this, creator)
  // Self-dispatch is bookkeeping, not a parent Attempt.
  const local = own && !isSelfCreatedDispatch(own) ? own : undefined
  const remote =
    creator.kind === 'terminal' ? findPotentiallyLiveAttachmentsForCreator.call(this, creator) : []
  if ((local ? 1 : 0) + remote.length !== 1) {
    return null
  }
  return local?.id ?? remote[0]?.dispatch_id ?? null
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

  const matches = rows.filter(
    (row) => row.pane_key !== null && isEquivalentPaneKey(row.pane_key, creator.paneKey as string)
  )

  // Multiple live attachments for one identity are ambiguous; never pick one silently.
  if (matches.length > 1) {
    throw new AmbiguousDispatchParentError(
      `Terminal ${creator.handle} matches ${matches.length} live remote attachments; cannot establish nesting depth.`
    )
  }
  return matches
}

/** Every live-worker insertion must enforce this depth cap before stamping the row. */
export function resolveChildDispatchDepth(
  this: OrchestrationDb,
  creator: DispatchCreator,
  maxDepth: number
): number {
  const childDepth = this.resolveCreatorDepth(creator) + 1
  if (childDepth > maxDepth) {
    throw new OrchestrationError(
      NESTED_WORKER_DEPTH_EXCEEDED_CODE,
      nestedWorkerDepthExceededMessage(childDepth, maxDepth),
      { effectsApplied: false, nextSteps: [...NESTED_WORKER_DEPTH_EXCEEDED_NEXT_STEPS] }
    )
  }
  return childDepth
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
