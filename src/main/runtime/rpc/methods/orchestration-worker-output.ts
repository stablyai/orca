import type {
  OrchestrationWorkerReadFallbackReason,
  OrchestrationWorkerReadResult,
  OrchestrationWorkerReadSource
} from '../../../../shared/orchestration-worker-output'
import type { RuntimeTerminalState } from '../../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  createWorkerOutputSourceIdentity,
  decodeWorkerOutputCursor,
  encodeWorkerOutputCursor
} from '../../orchestration/worker-output-cursor'
import { redactWorkerTerminalLines } from '../../orchestration/worker-transcript-payload'
import { readWorkerTranscript } from '../../orchestration/worker-transcript-read'

export async function readExactWorkerOutput(args: {
  runtime: OrcaRuntimeService
  dispatchId: string
  terminalHandle: string
  workerState: string
  terminalStatus: RuntimeTerminalState
  attachedAt: string
  source?: OrchestrationWorkerReadSource
  cursor?: string | number
  limit?: number
}): Promise<OrchestrationWorkerReadResult> {
  const source = args.source ?? 'auto'
  const cursor = decodeWorkerOutputCursor(args.cursor, args.dispatchId)
  assertCursorSourceMatchesRequest(cursor?.source, source)

  if (cursor?.source === 'terminal' || source === 'terminal') {
    return readTerminalOutput(args, cursor)
  }

  const observedAfter = orchestrationTimestampToMs(args.attachedAt)
  const session = args.runtime.getExactWorkerProviderSession(args.terminalHandle, observedAfter)
  if (!session) {
    if (cursor?.source === 'transcript') {
      throw sourceChanged()
    }
    return fallbackOrThrow(args, 'session_not_reported')
  }
  const transcript = await readWorkerTranscript({
    agent: session.agent,
    sessionId: session.providerSession.id,
    transcriptPath: session.providerSession.transcriptPath,
    offset: cursor?.source === 'transcript' ? cursor.position : undefined,
    limit: args.limit
  })
  if (!transcript.ok) {
    if (transcript.reason === 'source_changed') {
      throw sourceChanged()
    }
    if (cursor?.source === 'transcript') {
      throw transcriptRequired(args.dispatchId, transcript.reason)
    }
    return fallbackOrThrow(args, transcript.reason, transcript.warnings)
  }
  const sourceIdentity = createWorkerOutputSourceIdentity([
    'transcript',
    session.processIncarnation,
    session.agent,
    session.providerSession.key,
    session.providerSession.id,
    transcript.filePath
  ])
  if (cursor?.source === 'transcript' && cursor.sourceIdentity !== sourceIdentity) {
    throw sourceChanged()
  }
  const sessionAfterRead = args.runtime.getExactWorkerProviderSession(
    args.terminalHandle,
    observedAfter
  )
  if (
    !sessionAfterRead ||
    sessionAfterRead.processIncarnation !== session.processIncarnation ||
    sessionAfterRead.agent !== session.agent ||
    sessionAfterRead.providerSession.key !== session.providerSession.key ||
    sessionAfterRead.providerSession.id !== session.providerSession.id ||
    sessionAfterRead.providerSession.transcriptPath !== session.providerSession.transcriptPath
  ) {
    throw sourceChanged()
  }
  const nextCursor = encodeWorkerOutputCursor(
    args.dispatchId,
    'transcript',
    sourceIdentity,
    transcript.nextOffset
  )
  return {
    dispatchId: args.dispatchId,
    source: 'transcript',
    sourceIdentity,
    provider: session.agent,
    transcript: {
      messages: transcript.messages,
      nextCursor,
      limited: transcript.limited,
      returnedMessageCount: transcript.messages.length
    },
    cursor: nextCursor,
    status: { worker: args.workerState, terminal: args.terminalStatus },
    fallbackReason: null,
    warnings: transcript.warnings
  }
}

async function readTerminalOutput(
  args: Parameters<typeof readExactWorkerOutput>[0],
  cursor: ReturnType<typeof decodeWorkerOutputCursor>
): Promise<OrchestrationWorkerReadResult> {
  const processIncarnation = args.runtime.getTerminalProcessIncarnation(args.terminalHandle)
  const paneKey = args.runtime.getTerminalPaneKey(args.terminalHandle)
  if (!processIncarnation || !paneKey) {
    throw new OrchestrationError(
      'worker_identity_changed',
      `Worker Dispatch ${args.dispatchId} no longer resolves to its exact process.`
    )
  }
  const sourceIdentity = createWorkerOutputSourceIdentity(['terminal', processIncarnation, paneKey])
  if (
    cursor?.source === 'terminal' &&
    cursor.sourceIdentity !== null &&
    cursor.sourceIdentity !== sourceIdentity
  ) {
    throw sourceChanged()
  }
  const terminal = await args.runtime.readTerminal(args.terminalHandle, {
    cursor: cursor?.source === 'terminal' ? cursor.position : undefined,
    limit: args.limit
  })
  const redactedTerminal = redactWorkerTerminalLines(terminal.tail)
  const position =
    terminal.nextCursor !== null && /^\d+$/.test(terminal.nextCursor)
      ? Number.parseInt(terminal.nextCursor, 10)
      : null
  const nextCursor =
    position === null
      ? null
      : encodeWorkerOutputCursor(args.dispatchId, 'terminal', sourceIdentity, position)
  return {
    dispatchId: args.dispatchId,
    source: 'terminal',
    sourceIdentity,
    terminal: { ...terminal, tail: redactedTerminal.lines },
    cursor: nextCursor,
    status: { worker: args.workerState, terminal: terminal.status },
    fallbackReason: null,
    warnings: redactedTerminal.warnings
  }
}

async function fallbackOrThrow(
  args: Parameters<typeof readExactWorkerOutput>[0],
  reason: OrchestrationWorkerReadFallbackReason,
  warnings: string[] = []
): Promise<OrchestrationWorkerReadResult> {
  if (args.source === 'transcript') {
    throw transcriptRequired(args.dispatchId, reason)
  }
  const fallback = await readTerminalOutput(args, null)
  return fallback.source === 'terminal'
    ? {
        ...fallback,
        fallbackReason: reason,
        warnings: [...new Set([...fallback.warnings, ...warnings])]
      }
    : fallback
}

function assertCursorSourceMatchesRequest(
  cursorSource: 'terminal' | 'transcript' | undefined,
  requestedSource: OrchestrationWorkerReadSource
): void {
  if (cursorSource && requestedSource !== 'auto' && cursorSource !== requestedSource) {
    throw new OrchestrationError(
      'cursor_invalid',
      `The worker-read cursor is pinned to ${cursorSource} output.`
    )
  }
}

function orchestrationTimestampToMs(value: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

function sourceChanged(): OrchestrationError {
  return new OrchestrationError(
    'source_changed',
    'The worker output source changed. Start a fresh worker-read without the old cursor.'
  )
}

function transcriptRequired(
  dispatchId: string,
  reason: OrchestrationWorkerReadFallbackReason
): OrchestrationError {
  return new OrchestrationError(
    'transcript_required',
    `Structured output is unavailable for Dispatch ${dispatchId}: ${reason}.`,
    { reason }
  )
}
