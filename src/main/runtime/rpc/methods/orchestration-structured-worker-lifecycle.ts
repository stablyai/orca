/** Use live/unverifiable/exited evidence like SSH: loss of host-generation contact never proves death, including a structured host not yet installed. */

import type { AgentType, NativeChatMessage } from '../../../../shared/native-chat-types'
import type { OrchestrationWorkerReadTranscriptResult } from '../../../../shared/orchestration-worker-output'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  buildStructuredJournalArchive,
  captureRetiredLineageArchive,
  type WorkerStructuredJournalArchive
} from '../../orchestration/structured-worker-journal-archive'
import {
  readStructuredLineageJournalPage,
  type StructuredLineageJournalPage
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
  requireRunningStructuredWorker,
  resolveStructuredWorkerIdentity,
  structuredWorkerAgent,
  structuredWorkerTerminalState,
  type StructuredWorkerObservation
} from '../../structured-worker-authority'
import { structuredWorkerOwned } from '../../structured-worker-custody'
import type { StructuredWorkerIdentity } from '../../structured-worker-identity'
import type { WorkerTerminalReleaseState } from '../../orchestration/worker-terminal-ownership'
import { releaseStructuredWorkerSession } from './orchestration-structured-worker-session'
import { closeStructuredAgentSessionChild } from '../../agent-session/structured-agent-session-close'
import {
  chatAssigneeJournal,
  type StructuredJournalSource
} from './orchestration-chat-assignee-journal'

export { observeStructuredWorker, structuredWorkerOwned, type StructuredWorkerObservation }

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

/** Prove stop by observing no host-held session and no live lease after close; void close alone proves nothing.
 * Re-resolve /clear successors after each close. Unverifiable sessions remain untouched and retained. */
export async function stopStructuredWorker(
  identity: StructuredWorkerIdentity,
  runtime?: Pick<
    OrcaRuntimeService,
    'forgetStructuredSessionMail' | 'retireStructuredAgentSessionTabFromSnapshot'
  >,
  admitClose?: () => boolean
): Promise<StructuredWorkerStopOutcome> {
  const closed = new Set<string>()
  // Any close this stop issued, so a later session's failure cannot erase an earlier close.
  let closeAttempted = false
  for (;;) {
    let sessionId: string
    try {
      sessionId = requireRunningStructuredWorker(identity).sessionId
    } catch (error) {
      // Return uncertainty so worker-stop can settle its already-stopping dispatch instead of stranding it.
      const reason = error instanceof Error ? error.message : String(error)
      return { stopped: false, closeAttempted, reason }
    }
    if (closed.has(sessionId)) {
      return { stopped: true, closeAttempted }
    }
    closed.add(sessionId)
    const outcome = await closeStructuredAgentSessionChild(sessionId, {
      ...(runtime ? { runtime } : {}),
      ...(admitClose ? { admitClose } : {}),
      // Release redrive after close but before proof; an unsettled close returns early, leaving an unowned subscription otherwise.
      afterClose: () => releaseStructuredWorkerSession(identity.sessionId, runtime)
    })
    closeAttempted ||= outcome.closeAttempted
    if (!outcome.stopped) {
      return { ...outcome, closeAttempted }
    }
  }
}

/** The structured half of `worker-read`, or null when a PTY worker owns the dispatch. */
export async function readStructuredWorkerOutput(args: {
  db: OrchestrationDb
  dispatchId: string
  workerState: string
  /** What the caller's observation actually proved; never inferred from being able to read. */
  liveness: StructuredWorkerObservation['status']
  source?: 'auto' | 'transcript' | 'terminal'
  cursor?: string | number
  limit?: number
}): Promise<OrchestrationWorkerReadTranscriptResult | null> {
  const identity = resolveStructuredWorkerForDispatch(args.db, args.dispatchId)
  const journal = identity
    ? { source: identity, agent: structuredWorkerAgent(identity) }
    : chatAssigneeJournal(args.db, args.dispatchId)
  if (!journal) {
    return null
  }
  if (args.source === 'terminal') {
    throw new OrchestrationError(
      'archive_unavailable',
      // Keep refusals mode-neutral; auto/transcript work for every worker.
      `Worker Dispatch ${args.dispatchId} has no terminal output; read it with --source auto or --source transcript.`
    )
  }
  return readStructuredWorkerJournal({
    identity: journal.source,
    dispatchId: args.dispatchId,
    workerState: args.workerState,
    liveness: args.liveness,
    agent: journal.agent,
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
    ...(args.limit === undefined ? {} : { limit: args.limit })
  })
}

/** Journal page in the shape `worker-read --source transcript` already serves. */
export async function readStructuredWorkerJournal(args: {
  identity: StructuredJournalSource
  dispatchId: string
  workerState: string
  liveness: StructuredWorkerObservation['status']
  agent: AgentType
  cursor?: string | number
  limit?: number
}): Promise<OrchestrationWorkerReadTranscriptResult> {
  const running = requireRunningStructuredWorker(args.identity)
  const page = await readStructuredLineageJournalPage(running.lineage)
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

/** Anchor cursors to the oldest item and the ids/revisions of messages below position.
 * Journal messages mutate or appear in place, so oldest-item-only misses omissions/duplicates.
 * Hash only the consumed prefix: unseen tail growth must not invalidate active readers; oldest-item changes still detect window slides. */
function structuredJournalPrefixIdentity(args: {
  identity: StructuredJournalSource
  page: StructuredLineageJournalPage
  position: number
}): string {
  // Namespace successor items by session because /clear copies drafts; keep root ids bare for earlier cursors.
  const itemKey = (index: number): string => {
    const itemId = args.page.items[index]?.itemId ?? ''
    const sessionId = args.page.sessionIds[index]
    return sessionId === undefined || sessionId === args.identity.sessionId
      ? itemId
      : `${sessionId}/${itemId}`
  }
  // Fingerprint message-producing items in projection order; bounded output is their prefix.
  const projected = args.page.items.flatMap((item, index) =>
    projectStructuredItemToNativeChat(item) === null ? [] : [{ index, revision: item.revision }]
  )
  return createWorkerOutputSourceIdentity([
    'structured-journal',
    args.identity.processIncarnation,
    args.identity.paneKey,
    args.page.items.length > 0 ? itemKey(0) : '',
    ...projected
      .slice(0, args.position)
      .flatMap(({ index, revision }) => [itemKey(index), String(revision)])
  ])
}

/** Freezes the journal before the session is closed, so a released worker is still readable. */
export async function captureStructuredWorkerArchive(
  identity: StructuredWorkerIdentity,
  agent: AgentType
): Promise<WorkerStructuredJournalArchive> {
  const running = requireRunningStructuredWorker(identity)
  // Open resting journals too and preserve the whole /clear lineage.
  const page = await readStructuredLineageJournalPage(running.lineage)
  if (page) {
    return buildStructuredJournalArchive({
      agent,
      processIncarnation: identity.processIncarnation,
      items: page.items,
      hasOlder: page.hasOlder
    })
  }
  // Unreadable owned/unverifiable journals must retain evidence for later archive.
  // Only proven-retired lineages may skip missing journals: a user-closed chat can never supply more evidence.
  if (structuredWorkerOwned(running) !== false) {
    throw new OrchestrationError(
      'archive_failed',
      'Output could not be preserved for this structured worker; the session was retained.'
    )
  }
  // A retired lineage's unreadable sessions are gone for good; earlier ones may not be.
  return captureRetiredLineageArchive({
    agent,
    processIncarnation: identity.processIncarnation,
    lineage: running.lineage
  })
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
    // Frozen archives cannot revise under a cursor, so their identity is constant.
    identityAt: () => sourceIdentity,
    start: cursor?.position ?? 0,
    limit: args.limit,
    archived: true,
    // Archives precede close and prove no exit; only settled release can certify death (docs/reference/ssh-execution-boundary.md).
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
  // Stamp the prefix through end so later revisions below it invalidate the next cursor.
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
