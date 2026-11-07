import { createHash } from 'node:crypto'
import type { GeneratedAgentInputNotice } from '../../shared/generated-agent-input-notice'
import type { GeneratedInputNoticeOwner } from './generated-agent-input-notice-commands'

/** One failed request's notice: its operation id is the notice id, so a send's own failure, a
 *  recovery registration and a reload all land on this one record. */
export type GeneratedInputNoticeRegistration = Omit<GeneratedAgentInputNotice, 'id'> & {
  id?: string
  /** The window that owns a private notice; null keeps today's shared audience. */
  origin: string | null
  /** The window that started the operation when it has no audience yet (a host's in-flight
   *  operation for a paired window); else the origin. */
  initiator?: string | null
  /** Held from acceptance so a reload mid-request loses nothing; never shown while pending. */
  pending?: boolean
  /** The connection that installed a pending record; another connection of the same window
   *  re-subscribing means that renderer was replaced, so the record becomes a notice. */
  connection?: string
  /** The owner established the outcome itself (its operation ran); a client's inference never
   *  overrides that. */
  proven?: boolean
  /** This desktop's own client reports the outcome its answer gave, or of the text it wrote
   *  itself; only an outcome a host proved stands over it. */
  reported?: boolean
  /** Only from this runtime's own windows: the paired host that runs the request. */
  owner?: GeneratedInputNoticeOwner
}

/** What binds an operation id, without its text: kept once a window's copy gives way to its
 *  host's, so another obligation under the id is still refused. */
export type GeneratedInputNoticeIdentity = {
  digest: string
  submitted: boolean
  initiator: string | null
  ptyId: string | null
  handle: string
  owner?: GeneratedInputNoticeOwner
}

export type GeneratedInputNoticeRecord = {
  notice: GeneratedAgentInputNotice
  origin: string | null
  /** The window that started the operation, kept when a host promotes it to everyone. */
  initiator: string | null
  pending: boolean
  connection?: string
  proven: boolean
  /** Only the host's own prewrite target-gone answer lets the request move, once, to a fresh
   *  target. */
  retargetable: boolean
  /** A frame of it may have been taken: a later refused frame no longer proves it unsent. */
  mayHaveWritten: boolean
  owner?: GeneratedInputNoticeOwner
  /** The host keeps its own copy ('held'), or nothing more can reach it ('gone'). */
  fate?: 'held' | 'gone'
}

const digestOf = (text: string): string => createHash('sha256').update(text).digest('base64')

export function newNoticeRecord(
  id: string,
  input: GeneratedInputNoticeRegistration
): GeneratedInputNoticeRecord {
  const {
    origin,
    initiator = origin,
    pending = false,
    connection,
    proven = false,
    reported: _reported,
    owner,
    id: _id,
    ...fields
  } = input
  return {
    notice: { ...fields, id },
    origin,
    initiator,
    pending,
    proven,
    retargetable: false,
    mayHaveWritten: false,
    ...(connection ? { connection } : {}),
    ...(owner ? { owner: { ...owner } } : {})
  }
}

export function noticeIdentityOf(record: GeneratedInputNoticeRecord): GeneratedInputNoticeIdentity {
  return {
    digest: digestOf(record.notice.text),
    submitted: record.notice.submitted !== false,
    initiator: record.initiator,
    ptyId: record.notice.ptyId,
    handle: record.notice.handle,
    ...(record.owner ? { owner: record.owner } : {})
  }
}

/** Whether a registration names another obligation than the one bound to the id: its text,
 *  draft/prompt intent, initiating window, target or host receipt. Only a granted fresh-target
 *  move may change the target; the receipt's runtime, pairing and window never change. */
function conflicting(
  bound: GeneratedInputNoticeIdentity,
  input: GeneratedInputNoticeRegistration,
  sameText: boolean,
  retargetable: boolean
): boolean {
  const moved = (field: 'ptyId' | 'handle'): boolean =>
    !!input[field] && !!bound[field] && input[field] !== bound[field]
  const initiator = input.initiator ?? input.origin
  return (
    !sameText ||
    bound.submitted !== (input.submitted !== false) ||
    (initiator !== null && bound.initiator !== null && initiator !== bound.initiator) ||
    ((moved('ptyId') || moved('handle')) && !retargetable) ||
    (!!input.owner && !!bound.owner && !sameReceipt(bound.owner, input.owner))
  )
}

/** A later registration of an operation whose copy here gave way to its host's. */
export function conflictsWithNoticeIdentity(
  bound: GeneratedInputNoticeIdentity,
  input: GeneratedInputNoticeRegistration
): boolean {
  return conflicting(bound, input, digestOf(input.text) === bound.digest, false)
}

/** Another registration of the record's operation, applied to it; a conflict changes nothing.
 *  `claimedPending`: a window claimed the host's in-flight operation, still pending, as its own. */
export function mergeNoticeRegistration(
  existing: GeneratedInputNoticeRecord,
  input: GeneratedInputNoticeRegistration
): 'conflict' | { previous: GeneratedAgentInputNotice; changed: boolean; claimedPending: boolean } {
  const { origin, pending = false, proven = false, reported = false, owner } = input
  const previous = existing.notice
  const bound: GeneratedInputNoticeIdentity = {
    digest: '',
    submitted: previous.submitted !== false,
    initiator: existing.initiator,
    ptyId: previous.ptyId,
    handle: previous.handle,
    ...(existing.owner ? { owner: existing.owner } : {})
  }
  if (conflicting(bound, input, previous.text === input.text, existing.retargetable)) {
    return 'conflict'
  }
  const retargeted =
    (!!input.ptyId && !!previous.ptyId && input.ptyId !== previous.ptyId) ||
    (!!input.handle && !!previous.handle && input.handle !== previous.handle)
  let claimedPending = false
  const initiator = input.initiator ?? origin
  if (initiator !== null && existing.initiator === null) {
    existing.initiator = initiator
  }
  if (origin !== null && existing.origin === null && existing.pending) {
    // A window claims a host's in-flight operation: it becomes that window's private notice.
    existing.origin = origin
    claimedPending = pending
  }
  let next = previous
  // The owner's own outcome sets the certainty; anything else may only raise it to unconfirmed.
  if (proven) {
    existing.proven = true
    next = { ...next, certainty: input.certainty }
  } else if (!existing.proven && (reported || input.certainty === 'unconfirmed')) {
    // A frame this process saw possibly taken is never lowered by a client's report of it.
    const lowers = existing.mayHaveWritten && input.certainty === 'not-sent'
    next = { ...next, certainty: reported && !lowers ? input.certainty : 'unconfirmed' }
  }
  // Addressing fills what was unknown, or makes the one granted move to a fresh target.
  next = {
    ...next,
    ptyId: input.ptyId || next.ptyId,
    handle: input.handle || next.handle,
    worktreeId: input.worktreeId || next.worktreeId
  }
  if (owner) {
    // Fills what the receipt did not know; the fresh target's terminal replaces the old one.
    existing.owner = {
      ...owner,
      ...existing.owner,
      ...(retargeted && owner.terminal ? { terminal: owner.terminal } : {})
    }
  }
  if (retargeted) {
    // The one permitted move is spent, and the earlier attempt's fate no longer speaks for it.
    existing.retargetable = false
    delete existing.fate
  }
  const changed = (['certainty', 'ptyId', 'handle', 'worktreeId'] as const).some(
    (field) => next[field] !== previous[field]
  )
  if (changed) {
    existing.notice = next
  }
  return { previous, changed, claimedPending }
}

// A receipt field once known is fixed: another value under the same id is another operation.
function sameReceipt(bound: GeneratedInputNoticeOwner, given: GeneratedInputNoticeOwner): boolean {
  return (['environmentId', 'runtimeId', 'pairingRevision', 'window'] as const).every(
    (field) =>
      bound[field] === undefined || given[field] === undefined || bound[field] === given[field]
  )
}
