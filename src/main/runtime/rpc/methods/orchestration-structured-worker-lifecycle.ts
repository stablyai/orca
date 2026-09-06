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
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  buildStructuredJournalArchive,
  type WorkerStructuredJournalArchive
} from '../../orchestration/structured-worker-journal-archive'
import { readStructuredJournalPage } from '../../orchestration/structured-worker-journal-page'
import {
  createWorkerOutputSourceIdentity,
  decodeWorkerOutputCursor,
  encodeWorkerOutputCursor
} from '../../orchestration/worker-output-cursor'
import {
  boundWorkerTranscriptMessages,
  clampWorkerTranscriptLimit
} from '../../orchestration/worker-transcript-payload'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import {
  observeStructuredWorker,
  resolveStructuredWorkerIdentity,
  structuredWorkerAgent,
  structuredWorkerTerminalState,
  type StructuredWorkerObservation
} from '../../structured-worker-authority'
import { retireSettledStructuredWorkerTab } from '../../structured-agent-session-tab-retirement'
import type { StructuredWorkerIdentity } from '../../structured-worker-identity'
import type { WorkerTerminalReleaseState } from '../../orchestration/worker-terminal-ownership'
import { releaseStructuredWorkerSession } from './orchestration-structured-worker-session'

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
  const host = getStructuredAgentSessionHost()
  if (!host) {
    // Nothing was reached, so nothing was acted on; the receipt must not claim a close.
    return {
      stopped: false,
      closeAttempted: false,
      reason: 'The structured agent-session host is not installed; no session was closed.'
    }
  }
  // Set only once the close is actually issued: `setSessionTabVisibility` throwing first leaves a
  // running child, and a receipt that still said `closed_agent_terminal` for it would be the
  // close-that-never-happened this flag exists to rule out.
  let closeAttempted = false
  try {
    await host.setSessionTabVisibility?.(identity.sessionId, false)
    closeAttempted = true
    await host.close(identity.sessionId)
  } catch (error) {
    return {
      stopped: false,
      closeAttempted,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  releaseStructuredWorkerSession(dispatchId, runtime)
  const after = observeStructuredWorker(identity)
  if (after.status === 'live') {
    return {
      stopped: false,
      closeAttempted: true,
      reason: 'The structured session is still attached after close.'
    }
  }
  // Only past the proof, and structurally unable to throw: the worker's chat tab is retired from
  // the live snapshot, which `setSessionTabVisibility(false)` above does not do.
  retireSettledStructuredWorkerTab(identity.sessionId, runtime)
  return { stopped: true, closeAttempted: true }
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
  // The oldest item on the page anchors the identity, because the cursor position is an index
  // into THIS tail window. Once the journal outgrows the window it slides, and a stale index
  // silently resumes past the items it skipped; changing the identity turns that into the
  // `source_changed` the contract already defines.
  const sourceIdentity = createWorkerOutputSourceIdentity([
    'structured-journal',
    args.identity.processIncarnation,
    args.identity.paneKey,
    page.items[0]?.itemId ?? ''
  ])
  const cursor = decodeWorkerOutputCursor(args.cursor, args.dispatchId)
  if (cursor && (cursor.source !== 'transcript' || cursor.sourceIdentity !== sourceIdentity)) {
    throw new OrchestrationError(
      'source_changed',
      'The worker output source changed. Start a fresh worker-read without the old cursor.'
    )
  }
  const bounded = boundWorkerTranscriptMessages(projectStructuredItemsToNativeChat(page.items))
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
    sourceIdentity,
    start: cursor?.position ?? 0,
    limit: args.limit,
    archived: false,
    liveness: args.liveness
  })
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
    sourceIdentity,
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
  sourceIdentity: string
  start: number
  limit: number | undefined
  archived: boolean
  liveness: StructuredWorkerObservation['status']
}): OrchestrationWorkerReadTranscriptResult {
  const start = Math.min(input.start, input.messages.length)
  const end = Math.min(start + clampWorkerTranscriptLimit(input.limit), input.messages.length)
  const nextCursor = encodeWorkerOutputCursor(
    input.dispatchId,
    'transcript',
    input.sourceIdentity,
    end
  )
  return {
    dispatchId: input.dispatchId,
    source: 'transcript',
    sourceIdentity: input.sourceIdentity,
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
