import type {
  OrchestrationWorkerReadResult,
  OrchestrationWorkerReadSource
} from '../../../../../../shared/orchestration/workers/orchestration-worker-output'
import type { PtyLivenessVerdict } from '../../../../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'
import { readWorkerResumeSession } from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/terminal-authority/release/worker-terminal-ownership'
import { structuredWorkerAgent } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import {
  readWorkerOutputReference,
  type WorkerOutputReference
} from '../../../../orchestration/workers/archives/worker-output-archive'
import {
  createWorkerOutputSourceIdentity,
  decodeWorkerOutputCursor
} from '../../../../orchestration/workers/transcripts/worker-output-cursor'
import { readWorkerTranscript } from '../../../../orchestration/workers/transcripts/worker-transcript-read'
import {
  readStructuredWorkerJournal,
  resolveStructuredWorkerForDispatch
} from '../structured-workers/orchestration-structured-worker-lifecycle'
import { sourceChanged, workerTranscriptReadResult } from './worker-output'

type ReleasedWorkerReadArgs = {
  db: OrchestrationDb
  dispatchId: string
  workerState: string
  resource: Pick<WorkerTerminalResourceRow, 'id' | 'terminal_handle' | 'release_state'> &
    Partial<Pick<WorkerTerminalResourceRow, 'resume_session'>>
  source?: OrchestrationWorkerReadSource
  cursor?: string | number
  limit?: number
  /** Process evidence is separate from the fact that the worker was released. */
  liveness?: PtyLivenessVerdict['status']
}

/** A released worker's output, read from its original transcript or chat history as it is now. */
export async function readArchivedWorkerOutput(
  args: ReleasedWorkerReadArgs
): Promise<OrchestrationWorkerReadResult> {
  const archive = args.db.getWorkerTerminalArchive(args.dispatchId)
  if (!archive) {
    throw outputUnavailable(
      args.dispatchId,
      'it was released without a record of where its output lives'
    )
  }
  const reference = readWorkerOutputReference(archive)
  if (archive.kind === 'terminal_tail') {
    throw outputUnavailable(
      args.dispatchId,
      `it had no transcript to read (${reference.fallbackReason ?? 'session_not_reported'})`
    )
  }
  if (args.source === 'terminal') {
    throw new OrchestrationError(
      'archive_unavailable',
      `Dispatch ${args.dispatchId} keeps its transcript only; terminal output was released.`
    )
  }
  return archive.kind === 'structured_journal'
    ? readReleasedChatHistory(args, reference)
    : readReleasedTranscript(args, reference)
}

async function readReleasedTranscript(
  args: ReleasedWorkerReadArgs,
  reference: WorkerOutputReference
): Promise<OrchestrationWorkerReadResult> {
  // Rows written before references existed point at the conversation saved for resume.
  const resume = reference.sessionId
    ? null
    : readWorkerResumeSession({ resume_session: args.resource.resume_session ?? null })
  const agent = reference.agent ?? resume?.agent
  const sessionId = reference.sessionId ?? resume?.providerSession.id
  if (!agent || !sessionId) {
    throw outputUnavailable(args.dispatchId, 'its transcript was never located')
  }
  const cursor = decodeWorkerOutputCursor(args.cursor, args.dispatchId)
  if (cursor && (cursor.source !== 'transcript' || !cursor.boundaryCheckpoint)) {
    throw sourceChanged()
  }
  const transcript = await readWorkerTranscript({
    agent,
    sessionId,
    transcriptPath: reference.transcriptPath ?? resume?.providerSession.transcriptPath,
    wslDistro: reference.wslDistro,
    offset: cursor?.position,
    expectedBoundaryCheckpoint: cursor?.boundaryCheckpoint ?? undefined,
    limit: args.limit
  })
  if (!transcript.ok) {
    if (transcript.reason === 'source_changed') {
      throw sourceChanged()
    }
    throw outputUnavailable(args.dispatchId, `its transcript is gone (${transcript.reason})`)
  }
  const sourceIdentity = createWorkerOutputSourceIdentity([
    'released-transcript',
    args.resource.id,
    reference.processIncarnation ?? '',
    agent,
    sessionId,
    transcript.filePath,
    transcript.sourceFingerprint
  ])
  if (cursor && cursor.sourceIdentity !== sourceIdentity) {
    throw sourceChanged()
  }
  return {
    ...workerTranscriptReadResult({
      dispatchId: args.dispatchId,
      sourceIdentity,
      agent,
      transcript,
      status: releasedStatus(args)
    }),
    archived: true
  }
}

async function readReleasedChatHistory(
  args: ReleasedWorkerReadArgs,
  reference: WorkerOutputReference
): Promise<OrchestrationWorkerReadResult> {
  const identity = resolveStructuredWorkerForDispatch(args.db, args.dispatchId)
  if (!identity) {
    throw outputUnavailable(args.dispatchId, 'its chat is no longer recorded')
  }
  const status = releasedStatus(args)
  try {
    return await readStructuredWorkerJournal({
      identity,
      dispatchId: args.dispatchId,
      workerState: args.workerState,
      liveness: status.liveness,
      agent: reference.agent ?? structuredWorkerAgent(identity),
      archived: true,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      ...(args.limit === undefined ? {} : { limit: args.limit })
    })
  } catch (error) {
    if (error instanceof OrchestrationError && error.code === 'source_changed') {
      throw error
    }
    throw outputUnavailable(args.dispatchId, 'its chat history could not be read')
  }
}

function releasedStatus(args: ReleasedWorkerReadArgs): {
  worker: string
  terminal: 'running' | 'exited' | 'unknown'
  liveness: PtyLivenessVerdict['status']
} {
  // Only a settled host-confirmed release proves exit.
  const liveness =
    args.liveness ?? (args.resource.release_state === 'released' ? 'exited' : 'unverifiable')
  return {
    worker: args.workerState,
    terminal: liveness === 'live' ? 'running' : liveness === 'exited' ? 'exited' : 'unknown',
    liveness
  }
}

function outputUnavailable(dispatchId: string, why: string): OrchestrationError {
  return new OrchestrationError(
    'archive_unavailable',
    `The output of Dispatch ${dispatchId} is no longer available: ${why}. See its report (worker_done) or task result.`
  )
}
