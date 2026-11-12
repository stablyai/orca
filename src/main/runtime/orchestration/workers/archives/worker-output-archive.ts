import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { resolveNativeChatTranscriptAgent } from '../../../../../shared/native-chat/native-chat-agent-support'
import {
  ORCHESTRATION_WORKER_READ_FALLBACK_REASONS,
  type ExactWorkerProviderSession,
  type OrchestrationWorkerReadFallbackReason
} from '../../../../../shared/orchestration/workers/orchestration-worker-output'
import { isWslHookRelayConnectionId } from '../../../../../shared/wsl-hook-relay-contract'
import type { WorkerTerminalReleaseRuntime } from '../../terminal-authority/release/worker-terminal-release-runtime'
import type {
  WorkerTerminalArchiveKind,
  WorkerTerminalArchiveRow,
  WorkerTerminalArchiveStatus
} from '../../terminal-authority/release/worker-terminal-ownership'
import {
  requireRunningStructuredWorker,
  structuredWorkerAgent
} from '../../terminal-authority/structured-sessions/structured-worker-authority'
import type { StructuredWorkerIdentity } from '../../terminal-authority/structured-sessions/structured-worker-identity'

/** Where a released worker's output still lives; readers open the original, never a saved copy. */
export type WorkerOutputReference = {
  version: 3
  agent?: AgentType
  processIncarnation?: string
  /** The provider transcript a terminal worker's reader opens. */
  sessionId?: string
  transcriptPath?: string
  wslDistro?: string
  /** Why a terminal worker left no transcript to read. */
  fallbackReason?: OrchestrationWorkerReadFallbackReason
}

export type WorkerOutputArchiveStatus = Extract<
  WorkerTerminalArchiveStatus,
  'captured' | 'unavailable'
>

export type WorkerOutputArchiveCapture = {
  kind: WorkerTerminalArchiveKind
  content: WorkerOutputReference
  status: WorkerOutputArchiveStatus
}

/** Record where a worker's output lives before its terminal or session closes. */
export function captureWorkerOutputReference(args: {
  runtime: Pick<WorkerTerminalReleaseRuntime, 'getExactWorkerProviderSession'>
  terminalHandle: string
  attachedAtMs: number
  /** Present when the worker IS a structured session; its chat history is its output. */
  structuredWorker?: StructuredWorkerIdentity | null
}): WorkerOutputArchiveCapture {
  if (args.structuredWorker) {
    // An unverifiable session refuses here, so its release ends release_unknown instead of closing it.
    requireRunningStructuredWorker(args.structuredWorker)
    return {
      kind: 'structured_journal',
      status: 'captured',
      content: {
        version: 3,
        agent: structuredWorkerAgent(args.structuredWorker),
        processIncarnation: args.structuredWorker.processIncarnation
      }
    }
  }
  const session = args.runtime.getExactWorkerProviderSession(args.terminalHandle, args.attachedAtMs)
  const unreachable = transcriptUnreachableReason(session)
  if (!session || unreachable) {
    return {
      kind: 'terminal_tail',
      status: 'unavailable',
      content: { version: 3, fallbackReason: unreachable ?? 'session_not_reported' }
    }
  }
  const { transcriptPath } = session.providerSession
  return {
    kind: 'transcript_pin',
    status: 'captured',
    content: {
      version: 3,
      agent: session.agent,
      processIncarnation: session.processIncarnation,
      sessionId: session.providerSession.id,
      ...(transcriptPath ? { transcriptPath } : {}),
      ...(session.wslDistro ? { wslDistro: session.wslDistro } : {})
    }
  }
}

function transcriptUnreachableReason(
  session: ExactWorkerProviderSession | null
): OrchestrationWorkerReadFallbackReason | null {
  if (!session) {
    return 'session_not_reported'
  }
  const isWslSession = isWslHookRelayConnectionId(session.connectionId)
  // No SSH filesystem provider is installed, so remote transcripts are unreachable.
  if ((isWslSession && !session.wslDistro) || (session.connectionId && !isWslSession)) {
    return 'remote_capability_unavailable'
  }
  return resolveNativeChatTranscriptAgent(session.agent) ? null : 'provider_unsupported'
}

/** The reference a row holds; rows written before references held a copy carrying the same fields. */
export function readWorkerOutputReference(
  archive: WorkerTerminalArchiveRow
): WorkerOutputReference {
  let parsed: unknown
  try {
    parsed = JSON.parse(archive.content)
  } catch {
    return { version: 3 }
  }
  const fields = new Map<string, unknown>(
    typeof parsed === 'object' && parsed !== null ? Object.entries(parsed) : []
  )
  const text = (name: string): string | undefined => {
    const value = fields.get(name)
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const fallbackReason = ORCHESTRATION_WORKER_READ_FALLBACK_REASONS.find(
    (reason) => reason === fields.get('fallbackReason')
  )
  const reference: WorkerOutputReference = { version: 3 }
  for (const name of [
    'agent',
    'processIncarnation',
    'sessionId',
    'transcriptPath',
    'wslDistro'
  ] as const) {
    const value = text(name)
    if (value) {
      reference[name] = value
    }
  }
  return fallbackReason ? { ...reference, fallbackReason } : reference
}

export function summarizeWorkerOutputArchive(archive: Pick<WorkerTerminalArchiveRow, 'kind'>): {
  source: 'transcript' | 'terminal'
  status: WorkerOutputArchiveStatus
} {
  // Report chat history as transcript output to preserve the existing paired-client source union.
  return archive.kind === 'terminal_tail'
    ? { source: 'terminal', status: 'unavailable' }
    : { source: 'transcript', status: 'captured' }
}

/** Errors at compile time if a capture kind is ever added that the durable row cannot store. */
type AssertAssignable<TValue extends TBound, TBound> = TValue
export type WorkerOutputArchiveCaptureKind = AssertAssignable<
  WorkerOutputArchiveCapture['kind'],
  WorkerTerminalArchiveKind
>

/** Archive fields a release commit records for an archive an earlier attempt already stored. */
export function releaseCommitFieldsForStoredArchive(
  archive: Pick<WorkerTerminalArchiveRow, 'kind'>
) {
  const stored = summarizeWorkerOutputArchive(archive)
  return { archiveSource: stored.source, archiveStatus: stored.status }
}

/** Archive fields a release commit publishes for a freshly recorded reference. */
export function releaseCommitFieldsForCapturedArchive(captured: WorkerOutputArchiveCapture) {
  return {
    kind: captured.kind,
    content: JSON.stringify(captured.content),
    ...releaseCommitFieldsForStoredArchive(captured)
  }
}
