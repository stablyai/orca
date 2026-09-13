import {
  NESTED_WORKER_DEPTH_EXCEEDED_CODE,
  NESTED_WORKER_DEPTH_EXCEEDED_NEXT_STEPS,
  ROOT_DISPATCH_DEPTH,
  nestedWorkerDepthExceededMessage
} from '../../../../shared/nested-worker-depth'
import { OrchestrationError } from '../orchestration-error'
import { isEquivalentPaneKey } from './pane-key-match'
import type { OrchestrationDb } from './orchestration-db'
import type { DispatchContextRow, RemoteDispatchAttachmentRow } from '../types'
import { potentiallyLiveRemoteAttachmentSql } from './federation/remote-attachment-liveness'

/**
 * Who is creating a dispatch row, for nesting-depth purposes.
 *
 * `system` is Orca's own in-process coordinator loop, which is host-local code
 * rather than a CLI caller and is a root by construction. It is an internal
 * discriminated branch on purpose — never a caller-supplied value, or a worker
 * could claim to be the loop.
 */
export type DispatchCreator =
  | { kind: 'system' }
  | {
      kind: 'terminal'
      handle: string
      paneKey?: string
      /** Remote attachment matching requires the exact incarnation; local rows do not. */
      processIncarnation?: string
    }

/** Creator identity to persist on a new row, so depth can later tell delegation from bookkeeping. */
export function recordedCreatorIdentity(creator: DispatchCreator): {
  creatorHandle: string | null
  creatorPaneKey: string | null
} {
  if (creator.kind === 'system') {
    return { creatorHandle: null, creatorPaneKey: null }
  }
  return { creatorHandle: creator.handle, creatorPaneKey: creator.paneKey ?? null }
}

/**
 * A row whose creator is its own assignee: a coordinator recording context against its own
 * terminal. Nothing was delegated, so it is not a nesting parent. Rows written before v37 record
 * no creator and keep counting, which is the pre-v37 answer and fails closed.
 */
function isSelfCreatedDispatch(row: DispatchContextRow): boolean {
  if (row.creator_pane_key && row.assignee_pane_key) {
    return isEquivalentPaneKey(row.creator_pane_key, row.assignee_pane_key)
  }
  return row.creator_handle != null && row.creator_handle === row.assignee_handle
}

/**
 * Attachment states in which the worker may still be running.
 *
 * `start_unknown` means prompt delivery may have succeeded; `stopping` and
 * `stop_unknown` do not establish that the process exited. Loss of contact is
 * never evidence of process death — see docs/reference/ssh-execution-boundary.md.
 * An `unverifiable` worker must still count as a nesting parent.
 */
export class AmbiguousDispatchParentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AmbiguousDispatchParentError'
  }
}

/**
 * Depth of the deepest live role this caller currently holds.
 *
 * Why the maximum rather than the first match: one terminal process can hold a
 * local dispatch and a remote attachment at the same time, and the command
 * cannot say which role motivated it. Taking the maximum cannot undercount, so
 * it cannot let a deep worker pass as a shallow one.
 */
export function resolveCreatorDepth(this: OrchestrationDb, creator: DispatchCreator): number {
  if (creator.kind === 'system') {
    return ROOT_DISPATCH_DEPTH
  }

  const depths: number[] = []

  // Local rows match on handle/pane as they always have. process_incarnation is
  // nullable here and context-only dispatch stores null deliberately, so
  // requiring it would drop real parents.
  const local = this.findActiveDispatchForAssignee(creator.handle, creator.paneKey) as
    | DispatchContextRow
    | undefined
  if (local && !isSelfCreatedDispatch(local)) {
    depths.push(local.depth)
  }

  for (const attachment of findPotentiallyLiveAttachmentsForCreator.call(this, creator)) {
    depths.push(attachment.depth)
  }

  return depths.length > 0 ? Math.max(...depths) : ROOT_DISPATCH_DEPTH
}

/**
 * Proven creator Attempt identity; null when system-owned, absent, or ambiguous.
 * Throws when multiple live remote attachments match the same terminal identity.
 */
export function resolveCreatorDispatchId(
  this: OrchestrationDb,
  creator: DispatchCreator
): string | null {
  if (creator.kind === 'system') {
    return null
  }
  const own = this.findActiveDispatchForAssignee(creator.handle, creator.paneKey)
  // Why: a self-dispatch is not a parent Attempt, so it must not be stamped as the child's creator.
  const local = own && !isSelfCreatedDispatch(own) ? own : undefined
  const remote = findPotentiallyLiveAttachmentsForCreator.call(this, creator)
  if ((local ? 1 : 0) + remote.length !== 1) {
    return null
  }
  return local?.id ?? remote[0]?.dispatch_id ?? null
}

/**
 * Remote attachments matching this caller's pane AND exact process incarnation.
 *
 * Handle is deliberately not compared: identity survives handle remint and
 * nothing updates `remote_dispatch_attachments.terminal_handle` when it happens,
 * so a stored-handle predicate would reject a live federated parent. Pane
 * equivalence plus exact incarnation is what remote authority already uses.
 */
function findPotentiallyLiveAttachmentsForCreator(
  this: OrchestrationDb,
  creator: Extract<DispatchCreator, { kind: 'terminal' }>
): RemoteDispatchAttachmentRow[] {
  if (!creator.paneKey || !creator.processIncarnation) {
    return []
  }
  const rows = this.db
    .prepare(
      `SELECT * FROM remote_dispatch_attachments
       WHERE process_incarnation = ?
         AND pane_key IS NOT NULL
         AND ${potentiallyLiveRemoteAttachmentSql()}`
    )
    .all(creator.processIncarnation) as RemoteDispatchAttachmentRow[]

  const matches = rows.filter(
    (row) => row.pane_key !== null && isEquivalentPaneKey(row.pane_key, creator.paneKey as string)
  )

  // Two live attachments for one identity is an anomaly, not a depth question.
  // Surface it rather than silently picking one.
  if (matches.length > 1) {
    throw new AmbiguousDispatchParentError(
      `Terminal ${creator.handle} matches ${matches.length} live remote attachments; cannot establish nesting depth.`
    )
  }
  return matches
}

/**
 * Depth to stamp on a row this creator is about to make, rejecting over-cap.
 *
 * Every path that mints a live worker goes through here, so the cap cannot be
 * skipped by adding a new spawn verb.
 */
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
