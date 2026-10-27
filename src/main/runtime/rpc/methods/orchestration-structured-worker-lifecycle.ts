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
import { readStructuredLineageJournalPage } from '../../orchestration/structured-worker-journal-page'
import {
  readStructuredJournalSince,
  readStructuredJournalTail,
  type StructuredJournalRead
} from '../../orchestration/structured-worker-journal-cursor'
import {
  createWorkerOutputSourceIdentity,
  decodeWorkerOutputCursor,
  encodeWorkerOutputCursor
} from '../../orchestration/worker-output-cursor'
import { clampWorkerTranscriptLimit } from '../../orchestration/worker-transcript-payload'
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
  dispatchId: string,
  runtime?: Pick<
    OrcaRuntimeService,
    'forgetStructuredSessionMail' | 'retireStructuredAgentSessionTabFromSnapshot'
  >
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
      // Release redrive after close but before proof; an unsettled close returns early, leaving an unowned subscription otherwise.
      afterClose: () => releaseStructuredWorkerSession(dispatchId, runtime, identity.sessionId)
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

/** Journal page in the shape `worker-read --source transcript` already serves; see `structured-worker-journal-cursor`. */
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
  const sourceIdentity = createWorkerOutputSourceIdentity([
    'structured-journal',
    args.identity.processIncarnation,
    args.identity.paneKey
  ])
  const cursor = decodeWorkerOutputCursor(args.cursor, args.dispatchId)
  if (
    cursor &&
    (cursor.source !== 'transcript' ||
      cursor.sourceIdentity !== sourceIdentity ||
      !cursor.boundaryCheckpoint)
  ) {
    throw sourceChanged()
  }
  const limit = clampWorkerTranscriptLimit(args.limit)
  let read: StructuredJournalRead
  if (cursor?.boundaryCheckpoint) {
    read = await readStructuredJournalSince(
      running.sessionId,
      { epoch: cursor.boundaryCheckpoint, sequence: cursor.position },
      limit
    )
  } else {
    const page = await readStructuredLineageJournalPage(running.lineage)
    if (!page) {
      throw new OrchestrationError(
        'transcript_required',
        `The transcript for Dispatch ${args.dispatchId} could not be read; its session is not attached.`
      )
    }
    read = readStructuredJournalTail(page, limit)
  }
  // The transcript cursor's checkpoint carries the journal epoch and its position the write sequence.
  const nextCursor = encodeWorkerOutputCursor(
    args.dispatchId,
    'transcript',
    sourceIdentity,
    read.next.sequence,
    read.next.epoch
  )
  return structuredTranscriptResult({
    dispatchId: args.dispatchId,
    workerState: args.workerState,
    agent: args.agent,
    liveness: args.liveness,
    sourceIdentity,
    messages: read.messages,
    nextCursor,
    limited: read.clipping.length > 0,
    clipping: read.clipping,
    warnings: read.warnings,
    archived: false
  })
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
    throw sourceChanged()
  }
  // Frozen archives cannot revise under a cursor, so a position pages them exactly.
  const messages = args.archive.messages
  const start = Math.min(cursor?.position ?? 0, messages.length)
  const end = Math.min(start + clampWorkerTranscriptLimit(args.limit), messages.length)
  return structuredTranscriptResult({
    dispatchId: args.dispatchId,
    workerState: args.workerState,
    agent: args.archive.agent,
    // Archives precede close and prove no exit; only settled release can certify death (docs/reference/ssh-execution-boundary.md).
    liveness: args.releaseState === 'released' ? 'exited' : 'unverifiable',
    sourceIdentity,
    messages: messages.slice(start, end),
    nextCursor: encodeWorkerOutputCursor(args.dispatchId, 'transcript', sourceIdentity, end),
    limited: args.archive.limited || end < messages.length,
    warnings: args.archive.warnings,
    archived: true
  })
}

function sourceChanged(): OrchestrationError {
  return new OrchestrationError(
    'source_changed',
    'The worker output source changed. Start a fresh worker-read without the old cursor.'
  )
}

function structuredTranscriptResult(input: {
  dispatchId: string
  workerState: string
  agent: AgentType
  liveness: StructuredWorkerObservation['status']
  sourceIdentity: string
  messages: NativeChatMessage[]
  nextCursor: string
  limited: boolean
  clipping?: string[]
  warnings: string[]
  archived: boolean
}): OrchestrationWorkerReadTranscriptResult {
  return {
    dispatchId: input.dispatchId,
    source: 'transcript',
    sourceIdentity: input.sourceIdentity,
    provider: input.agent,
    transcript: {
      messages: input.messages,
      nextCursor: input.nextCursor,
      limited: input.limited,
      returnedMessageCount: input.messages.length
    },
    cursor: input.nextCursor,
    status: {
      worker: input.workerState,
      terminal: structuredWorkerTerminalState(input.liveness),
      liveness: input.liveness
    },
    fallbackReason: null,
    contentComplete: !input.limited,
    ...(input.clipping?.length ? { clipping: input.clipping } : {}),
    warnings: input.warnings,
    ...(input.archived ? { archived: true } : {})
  }
}
