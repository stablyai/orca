import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { WorkerStructuredJournalArchive } from './structured-worker-journal-archive'
import { canReadWorkerTranscript } from '../transcripts/worker-transcript-read'
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
import type { WorkerTerminalResourceRow } from '../../terminal-authority/release/worker-terminal-ownership'
import { readWorkerResumeSession } from '../../db/dispatch-context/worker-follow-up-lineage'
import { parseWorkerTerminalHostScope } from '../../../../../shared/orchestration/workers/worker-terminal-host-scope'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { needsWslHostResolution } from '../../../../native-chat/transcript-discovery/host-readable-transcript-path'

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

/** Output copies saved by releases before references; their rows stay readable as they were. */
export type WorkerTranscriptSnapshotArchive = {
  version: 2
  agent: AgentType
  processIncarnation: string
  messages: NativeChatMessage[]
  limited: boolean
  clipping?: string[]
  warnings: string[]
}

export type WorkerTerminalTailArchive = {
  lines: string[]
  draft?: string
  truncated: boolean
  terminalStatus: string
  warnings: string[]
  /** Transcript-first attempt provenance preserved across release handoff. */
  fallbackReason?: OrchestrationWorkerReadFallbackReason
  clipping?: string[]
}

/** References serialize `version` first, so this never parses a saved copy. */
export function isWorkerOutputReference(
  archive: Pick<WorkerTerminalArchiveRow, 'content'>
): boolean {
  return archive.content.startsWith('{"version":3,') || archive.content === '{"version":3}'
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

/** Where a worker whose process is gone left its output, from what Orca saved while it ran. */
export function deriveWorkerOutputReferenceFromSavedState(args: {
  resource: Pick<WorkerTerminalResourceRow, 'resume_session' | 'host_scope'>
  structuredWorker?: StructuredWorkerIdentity | null
  platform?: NodeJS.Platform
}): WorkerOutputArchiveCapture {
  if (args.structuredWorker) {
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
  const session = readWorkerResumeSession(args.resource)
  const unavailable = (
    fallbackReason: OrchestrationWorkerReadFallbackReason
  ): WorkerOutputArchiveCapture => ({
    kind: 'terminal_tail',
    status: 'unavailable',
    content: { version: 3, fallbackReason }
  })
  if (!session) {
    return unavailable('session_not_reported')
  }
  if (!canReadWorkerTranscript(session.agent)) {
    return unavailable('provider_unsupported')
  }
  const scope = parseWorkerTerminalHostScope(args.resource.host_scope)
  const { id: sessionId, transcriptPath } = session.providerSession
  const platform = args.platform ?? process.platform
  // Resume state drops the WSL distro, so only the pane's own host scope can say which guest holds the file.
  const readable =
    session.captureHostId === LOCAL_EXECUTION_HOST_ID &&
    (scope?.kind === 'wsl'
      ? Boolean(transcriptPath)
      : scope?.kind === 'local' &&
        (transcriptPath ? !needsWslHostResolution(transcriptPath, platform) : platform !== 'win32'))
  if (!readable) {
    return unavailable('remote_capability_unavailable')
  }
  return {
    kind: 'transcript_pin',
    status: 'captured',
    // No processIncarnation: a reopened worker may still carry its predecessor's conversation.
    content: {
      version: 3,
      agent: session.agent,
      sessionId,
      ...(transcriptPath ? { transcriptPath } : {}),
      ...(scope?.kind === 'wsl' ? { wslDistro: scope.distro } : {})
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
  // The released read uses the same reader, so record only what it can open.
  return canReadWorkerTranscript(session.agent) ? null : 'provider_unsupported'
}

/** The reference a row holds; check isWorkerOutputReference first. */
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

export function summarizeWorkerOutputArchive(
  archive: Pick<WorkerTerminalArchiveRow, 'kind' | 'content'>
): {
  source: 'transcript' | 'terminal'
  status: WorkerTerminalArchiveStatus
} {
  if (!isWorkerOutputReference(archive)) {
    return summarizeSavedOutputCopy(archive)
  }
  return summarizeReferenceKind(archive.kind)
}

function summarizeReferenceKind(kind: WorkerTerminalArchiveKind): {
  source: 'transcript' | 'terminal'
  status: WorkerOutputArchiveStatus
} {
  // Report chat history as transcript output to preserve the existing paired-client source union.
  return kind === 'terminal_tail'
    ? { source: 'terminal', status: 'unavailable' }
    : { source: 'transcript', status: 'captured' }
}

function summarizeSavedOutputCopy(archive: Pick<WorkerTerminalArchiveRow, 'kind' | 'content'>): {
  source: 'transcript' | 'terminal'
  status: 'captured' | 'empty'
} {
  if (archive.kind === 'transcript_pin') {
    return { source: 'transcript', status: 'captured' }
  }
  if (archive.kind === 'structured_journal') {
    const journal = JSON.parse(archive.content) as WorkerStructuredJournalArchive
    return { source: 'transcript', status: journal.messages.length > 0 ? 'captured' : 'empty' }
  }
  const content = JSON.parse(archive.content) as WorkerTerminalTailArchive
  const empty =
    content.lines.every((line) => line.trim() === '') && (content.draft?.trim() ?? '') === ''
  return { source: 'terminal', status: empty ? 'empty' : 'captured' }
}

/** Errors at compile time if a capture kind is ever added that the durable row cannot store. */
type AssertAssignable<TValue extends TBound, TBound> = TValue
export type WorkerOutputArchiveCaptureKind = AssertAssignable<
  WorkerOutputArchiveCapture['kind'],
  WorkerTerminalArchiveKind
>

/** Archive fields a release commit records for an archive an earlier attempt already stored. */
export function releaseCommitFieldsForStoredArchive(
  archive: Pick<WorkerTerminalArchiveRow, 'kind' | 'content'>
) {
  const stored = summarizeWorkerOutputArchive(archive)
  return { archiveSource: stored.source, archiveStatus: stored.status }
}

/** Archive fields a release commit publishes for a freshly recorded reference. */
export function releaseCommitFieldsForCapturedArchive(captured: WorkerOutputArchiveCapture) {
  return {
    kind: captured.kind,
    content: JSON.stringify({ ...captured.content, ...olderReaderFields(captured.kind) }),
    archiveSource: summarizeReferenceKind(captured.kind).source,
    archiveStatus: captured.status
  }
}

const OLDER_READER_NOTE =
  'This version of Orca reads released output from the saved copy only. Read it with a newer Orca, or see its report (worker_done) or task result.'

/** Empty copy fields, so a downgraded Orca shows a note instead of failing on a reference row. */
function olderReaderFields(kind: WorkerTerminalArchiveKind) {
  return kind === 'terminal_tail'
    ? { lines: [], truncated: false, terminalStatus: 'exited', warnings: [OLDER_READER_NOTE] }
    : { messages: [], limited: true, warnings: [OLDER_READER_NOTE] }
}
