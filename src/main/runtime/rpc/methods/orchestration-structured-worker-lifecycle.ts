/**
 * The lifecycle verbs for a worker that IS a structured agent session.
 *
 * Observation follows the SSH execution-boundary vocabulary — `live` / `unverifiable` / `exited` —
 * because losing contact with a host generation is not a death certificate. In particular a
 * runtime that has not installed the structured host cannot see a session's child at all, and that
 * is `unverifiable`, never `exited`.
 */

import type { AgentType, NativeChatMessage } from '../../../../shared/native-chat-types'
import type { OrchestrationWorkerReadTranscriptResult } from '../../../../shared/orchestration-worker-output'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  buildStructuredJournalArchive,
  type WorkerStructuredJournalArchive
} from '../../orchestration/structured-worker-journal-archive'
import {
  readStructuredJournalPage,
  type StructuredJournalPage
} from '../../orchestration/structured-worker-journal-page'
import {
  createWorkerOutputSourceIdentity,
  decodeWorkerOutputCursor,
  encodeWorkerOutputCursor
} from '../../orchestration/worker-output-cursor'
import {
  boundWorkerTranscriptMessages,
  clampWorkerTranscriptLimit
} from '../../orchestration/worker-transcript-payload'
import {
  projectStructuredItemToNativeChat,
  projectStructuredItemsToNativeChat
} from '../../../../shared/structured-agent-session-projection'
import {
  observeStructuredWorker,
  resolveStructuredWorkerIdentity,
  structuredWorkerAgent,
  structuredWorkerTerminalState,
  type StructuredWorkerObservation
} from '../../structured-worker-authority'
import type { StructuredWorkerIdentity } from '../../structured-worker-identity'
import type { WorkerTerminalReleaseState } from '../../orchestration/worker-terminal-ownership'
import { releaseStructuredWorkerSession } from './orchestration-structured-worker-session'
import { closeStructuredAgentSessionChild } from '../../structured-agent-session-close'

export { observeStructuredWorker, type StructuredWorkerObservation }

/** The structured worker behind a dispatch, or null when a PTY worker owns it. */
export function resolveStructuredWorkerForDispatch(
  db: OrchestrationDb,
  dispatchId: string
): StructuredWorkerIdentity | null {
  const handle =
    db.getWorkerDispatch(dispatchId)?.agent_terminal_handle ??
    db.getDispatchContextById(dispatchId)?.assignee_handle
  return handle ? resolveStructuredWorkerIdentity(handle, db) : null
}

export type StructuredWorkerStopOutcome = {
  stopped: boolean
  /** Whether a close was actually issued; the receipt's `processAction` may claim nothing more. */
  closeAttempted: boolean
  reason?: string
}

/**
 * Stopping a structured worker.
 *
 * `host.close` returns void and keeps a failed close indexed for retry, so the only settlement
 * evidence is the observation AFTER it: a session the host no longer holds and whose lease is no
 * longer live is proven gone. Anything else is retained rather than settled.
 */
export async function stopStructuredWorker(
  identity: StructuredWorkerIdentity,
  dispatchId: string,
  runtime?: Pick<
    OrcaRuntimeService,
    'forgetStructuredSessionMail' | 'retireStructuredAgentSessionTabFromSnapshot'
  >
): Promise<StructuredWorkerStopOutcome> {
  return closeStructuredAgentSessionChild(identity.sessionId, {
    ...(runtime ? { runtime } : {}),
    // Between the close and the proof, never after: an unsettled close returns early, and a
    // surviving hold keeps the provider child un-evictable for the life of the app.
    afterClose: () => releaseStructuredWorkerSession(dispatchId, runtime)
  })
}

/** The structured half of `worker-read`, or null when a PTY worker owns the dispatch. */
export function readStructuredWorkerOutput(args: {
  db: OrchestrationDb
  dispatchId: string
  workerState: string
  /** What the caller's observation actually proved; never inferred from being able to read. */
  liveness: StructuredWorkerObservation['status']
  source?: 'auto' | 'transcript' | 'terminal'
  cursor?: string | number
  limit?: number
}): OrchestrationWorkerReadTranscriptResult | null {
  const identity = resolveStructuredWorkerForDispatch(args.db, args.dispatchId)
  if (!identity) {
    return null
  }
  if (args.source === 'terminal') {
    throw new OrchestrationError(
      'archive_unavailable',
      // Mode-neutral on purpose: a coordinator is never told which kind of worker it started, so
      // a refusal must not be the thing that discloses it. `auto` and `transcript` both work here.
      `Worker Dispatch ${args.dispatchId} has no terminal output; read it with --source auto or --source transcript.`
    )
  }
  return readStructuredWorkerJournal({
    identity,
    dispatchId: args.dispatchId,
    workerState: args.workerState,
    liveness: args.liveness,
    agent: structuredWorkerAgent(identity),
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
    ...(args.limit === undefined ? {} : { limit: args.limit })
  })
}

/** Journal page in the shape `worker-read --source transcript` already serves. */
export function readStructuredWorkerJournal(args: {
  identity: StructuredWorkerIdentity
  dispatchId: string
  workerState: string
  liveness: StructuredWorkerObservation['status']
  agent: AgentType
  cursor?: string | number
  limit?: number
}): OrchestrationWorkerReadTranscriptResult {
  const page = readStructuredJournalPage(args.identity.sessionId)
  if (!page) {
    throw new OrchestrationError(
      'transcript_required',
      `The transcript for Dispatch ${args.dispatchId} could not be read; its session is not attached.`
    )
  }
  const bounded = boundWorkerTranscriptMessages(projectStructuredItemsToNativeChat(page.items))
  // Identity of the PREFIX the caller already holds — see `structuredJournalPrefixIdentity`.
  const identityAt = (position: number): string =>
    structuredJournalPrefixIdentity({ identity: args.identity, page, position })
  const cursor = decodeWorkerOutputCursor(args.cursor, args.dispatchId)
  if (
    cursor &&
    (cursor.source !== 'transcript' || cursor.sourceIdentity !== identityAt(cursor.position))
  ) {
    throw new OrchestrationError(
      'source_changed',
      'The worker output source changed. Start a fresh worker-read without the old cursor.'
    )
  }
  return pageMessages({
    messages: bounded.messages,
    warnings: [
      ...bounded.warnings,
      ...(page.hasOlder ? ['Older journal items were omitted from this page.'] : [])
    ],
    limited: bounded.limited || page.hasOlder,
    dispatchId: args.dispatchId,
    workerState: args.workerState,
    agent: args.agent,
    identityAt,
    start: cursor?.position ?? 0,
    limit: args.limit,
    archived: false,
    liveness: args.liveness
  })
}

/**
 * The cursor's `source_changed` anchor: the window's oldest item, plus every item whose projected
 * message sits BELOW `position`, by id AND revision.
 *
 * The journal is a reduced, MUTABLE timeline, so a message index over it is not self-validating and
 * the old oldest-item-only fingerprint could not see the normal case. A `running` tool item gains
 * its `[tool result]` at its original sequence once later items exist, the delta coalescer revises a
 * message in place, settlement can rewrite an item smaller, and a pending approval projects to null
 * until it resolves and then appears in the MIDDLE of the array. Under a stable oldest item that
 * fingerprint stayed valid through all of it: a caller could be handed `hel`, resume past it and
 * never receive the revision to `hello world` (omission), or have a resolved approval insert ahead
 * of its saved index and re-read what it already had (duplication) — both returning ok.
 *
 * Scoped to the prefix rather than the whole page ON PURPOSE. Fingerprinting every item would flip
 * the identity every 60ms with the coalescer window during an active turn, making the cursor
 * unusable exactly while the worker is working — a useless verb in place of a silent bug. Tail
 * growth the caller has not read yet cannot invalidate; a change to what it already holds does.
 * Position-dependence is safe because `p` rides in the same opaque payload as the identity.
 *
 * The oldest item stays in the anchor as the window-slide detector: a slide shifts every index.
 */
function structuredJournalPrefixIdentity(args: {
  identity: StructuredWorkerIdentity
  page: StructuredJournalPage
  position: number
}): string {
  // Items that project to a message, in message order. `projectStructuredItemsToNativeChat` keeps
  // order and drops the rest, and `boundWorkerTranscriptMessages` returns a PREFIX of that, so
  // message index i is item i here for every index a cursor can name.
  const projected = args.page.items.filter(
    (item) => projectStructuredItemToNativeChat(item) !== null
  )
  return createWorkerOutputSourceIdentity([
    'structured-journal',
    args.identity.processIncarnation,
    args.identity.paneKey,
    args.page.items[0]?.itemId ?? '',
    ...projected.slice(0, args.position).flatMap((item) => [item.itemId, String(item.revision)])
  ])
}

/** Freezes the journal before the session is closed, so a released worker is still readable. */
export function captureStructuredWorkerArchive(
  identity: StructuredWorkerIdentity,
  agent: AgentType
): WorkerStructuredJournalArchive {
  const page = readStructuredJournalPage(identity.sessionId)
  if (page) {
    return buildStructuredJournalArchive({
      agent,
      processIncarnation: identity.processIncarnation,
      items: page.items,
      hasOlder: page.hasOlder
    })
  }
  // An unreadable journal is `archive_failed`, and release retains the worker so the evidence can
  // still be preserved later — the same contract the PTY path keeps. It holds only while the
  // evidence might still arrive. A session PROVEN gone detaches its journal for good, and closing
  // the worker's chat tab is a routine user action that does exactly that, so throwing there wedges
  // release on evidence that can never come and leaves `worker-abandon` as the only exit.
  //
  // `exited` is the only verdict that qualifies: it needs a released lease WITH death evidence.
  // `unverifiable` — no host installed, a lease handed to a TUI owner — means we could not look,
  // and retaining is still right.
  if (observeStructuredWorker(identity).status !== 'exited') {
    throw new OrchestrationError(
      'archive_failed',
      'Output could not be preserved for this structured worker; the session was retained.'
    )
  }
  const empty = buildStructuredJournalArchive({
    agent,
    processIncarnation: identity.processIncarnation,
    items: [],
    hasOlder: false
  })
  return {
    ...empty,
    warnings: [
      ...empty.warnings,
      'The structured session was already closed, so its journal could not be preserved.'
    ]
  }
}

export function readArchivedStructuredJournal(args: {
  dispatchId: string
  workerState: string
  resourceId: string
  createdAt: string
  /** Only a SETTLED release proves the session is gone; `releasing` and `unknown` never do. */
  releaseState: WorkerTerminalReleaseState
  archive: WorkerStructuredJournalArchive
  cursor?: string | number
  limit?: number
}): OrchestrationWorkerReadTranscriptResult {
  const sourceIdentity = createWorkerOutputSourceIdentity([
    'released-structured-journal',
    args.resourceId,
    args.archive.processIncarnation,
    args.createdAt
  ])
  const cursor = decodeWorkerOutputCursor(args.cursor, args.dispatchId)
  if (cursor && (cursor.source !== 'transcript' || cursor.sourceIdentity !== sourceIdentity)) {
    throw new OrchestrationError(
      'source_changed',
      'The worker output source changed. Start a fresh worker-read without the old cursor.'
    )
  }
  return pageMessages({
    messages: args.archive.messages,
    warnings: args.archive.warnings,
    limited: args.archive.limited,
    dispatchId: args.dispatchId,
    workerState: args.workerState,
    agent: args.archive.agent,
    // Constant on purpose: the archive is FROZEN before the close, so no item can be revised under
    // a caller and there is no prefix to fingerprint.
    identityAt: () => sourceIdentity,
    start: cursor?.position ?? 0,
    limit: args.limit,
    archived: true,
    // The archive is frozen BEFORE the close, so it proves nothing about the child. Only a
    // settled release row proves the close landed; `releasing` and `unknown` are the states
    // that exist to say it did not, and answering `exited` from one of them is the death
    // certificate `docs/reference/ssh-execution-boundary.md` forbids.
    liveness: args.releaseState === 'released' ? 'exited' : 'unverifiable'
  })
}

function pageMessages(input: {
  messages: readonly NativeChatMessage[]
  warnings: string[]
  limited: boolean
  dispatchId: string
  workerState: string
  agent: AgentType
  /** Identity of the prefix below a position; the returned cursor is stamped with its own end. */
  identityAt: (position: number) => string
  start: number
  limit: number | undefined
  archived: boolean
  liveness: StructuredWorkerObservation['status']
}): OrchestrationWorkerReadTranscriptResult {
  const start = Math.min(input.start, input.messages.length)
  const end = Math.min(start + clampWorkerTranscriptLimit(input.limit), input.messages.length)
  // Stamped with the identity of everything up to `end`, which is exactly what the next read
  // recomputes and compares — so a later in-place revision below it is caught.
  const sourceIdentity = input.identityAt(end)
  const nextCursor = encodeWorkerOutputCursor(input.dispatchId, 'transcript', sourceIdentity, end)
  return {
    dispatchId: input.dispatchId,
    source: 'transcript',
    sourceIdentity,
    provider: input.agent,
    transcript: {
      messages: input.messages.slice(start, end),
      nextCursor,
      limited: input.limited || end < input.messages.length,
      returnedMessageCount: end - start
    },
    cursor: nextCursor,
    status: {
      worker: input.workerState,
      terminal: structuredWorkerTerminalState(input.liveness),
      liveness: input.liveness
    },
    fallbackReason: null,
    warnings: input.warnings,
    ...(input.archived ? { archived: true } : {})
  }
}
