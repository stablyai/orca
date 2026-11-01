import type { AgentType, NativeChatMessage } from '../../../shared/native-chat-types'
import type { OrchestrationWorkerReadFallbackReason } from '../../../shared/orchestration-worker-output'
import type { WorkerTerminalReleaseRuntime } from './worker-terminal-release-runtime'
import { OrchestrationError } from './orchestration-error'
import type {
  WorkerTerminalArchiveKind,
  WorkerTerminalArchiveRow,
  WorkerTerminalArchiveStatus
} from './worker-terminal-ownership'
import { MAX_WORKER_TRANSCRIPT_MESSAGE_LIMIT } from './worker-transcript-payload'
import { redactWorkerTerminalLines } from './worker-terminal-redaction'
import { readWorkerTranscript } from './worker-transcript-read'
import { isWslHookRelayConnectionId } from '../../../shared/wsl-hook-relay-contract'
import { captureStructuredWorkerArchive } from '../rpc/methods/orchestration-structured-worker-lifecycle'
import type { WorkerStructuredJournalArchive } from './structured-worker-journal-archive'
import { structuredWorkerAgent } from '../structured-worker-authority'
import type { StructuredWorkerIdentity } from '../structured-worker-identity'
import { readWorkerTerminalArchive } from './worker-terminal-archive-read'

// Bound the durable copy of raw terminal output; the tail end is the evidence that matters.
const TERMINAL_ARCHIVE_MAX_CHARS = 262_144

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

export type WorkerOutputArchiveCapture =
  | {
      kind: 'transcript_pin'
      content: WorkerTranscriptSnapshotArchive
      status: 'captured'
    }
  | {
      kind: 'structured_journal'
      content: WorkerStructuredJournalArchive
      status: 'captured' | 'empty'
    }
  | { kind: 'terminal_tail'; content: WorkerTerminalTailArchive; status: 'captured' | 'empty' }

export function summarizeWorkerOutputArchive(archive: WorkerTerminalArchiveRow): {
  source: 'transcript' | 'terminal'
  status: Extract<WorkerTerminalArchiveStatus, 'captured' | 'empty'>
} {
  if (archive.kind === 'transcript_pin') {
    return { source: 'transcript', status: 'captured' }
  }
  if (archive.kind === 'structured_journal') {
    // Report journals as transcript output to preserve the existing paired-client source union.
    const journal = JSON.parse(archive.content) as WorkerStructuredJournalArchive
    return { source: 'transcript', status: journal.messages.length > 0 ? 'captured' : 'empty' }
  }
  const content = JSON.parse(archive.content) as WorkerTerminalTailArchive
  const empty =
    content.lines.every((line) => line.trim() === '') && (content.draft?.trim() ?? '') === ''
  return {
    source: 'terminal',
    status: empty ? 'empty' : 'captured'
  }
}

// Archive exact provider transcript or redacted terminal tail before close; typed archive_failed retains live output.
export async function captureWorkerOutputArchive(args: {
  runtime: WorkerTerminalReleaseRuntime
  dispatchId: string
  terminalHandle: string
  attachedAtMs: number
  /** Present when the worker IS a structured session; its journal is the only output it has. */
  structuredWorker?: StructuredWorkerIdentity | null
}): Promise<WorkerOutputArchiveCapture> {
  if (args.structuredWorker) {
    const content = await captureStructuredWorkerArchive(
      args.structuredWorker,
      structuredWorkerAgent(args.structuredWorker)
    )
    return {
      kind: 'structured_journal',
      status: content.messages.length > 0 ? 'captured' : 'empty',
      content
    }
  }
  const session = args.runtime.getExactWorkerProviderSession(args.terminalHandle, args.attachedAtMs)
  let transcriptFallbackReason: OrchestrationWorkerReadFallbackReason = 'session_not_reported'
  if (session) {
    transcriptFallbackReason = 'transcript_unreadable'
    const isWslSession = isWslHookRelayConnectionId(session.connectionId)
    // No SSH filesystem provider is installed, so remote transcripts are unreachable.
    const isSshSession = Boolean(session.connectionId) && !isWslSession
    if ((isWslSession && !session.wslDistro) || isSshSession) {
      transcriptFallbackReason = 'remote_capability_unavailable'
    } else {
      const snapshot = await readWorkerTranscript({
        agent: session.agent,
        sessionId: session.providerSession.id,
        transcriptPath: session.providerSession.transcriptPath,
        wslDistro: session.wslDistro,
        limit: MAX_WORKER_TRANSCRIPT_MESSAGE_LIMIT
      }).catch(() => null)
      if (snapshot?.ok && snapshot.messages.length > 0) {
        return {
          kind: 'transcript_pin',
          status: 'captured',
          content: {
            version: 2,
            agent: session.agent,
            processIncarnation: session.processIncarnation,
            messages: snapshot.messages,
            limited: snapshot.limited,
            clipping: snapshot.clipping,
            warnings: snapshot.warnings
          }
        }
      }
      if (snapshot?.ok) {
        transcriptFallbackReason = snapshot.limited ? 'transcript_unreadable' : 'transcript_empty'
      } else if (snapshot) {
        transcriptFallbackReason =
          snapshot.reason === 'source_changed' ? 'transcript_unreadable' : snapshot.reason
      }
    }
  }
  let terminal
  try {
    terminal = await readWorkerTerminalArchive(args.runtime, args.terminalHandle)
  } catch (error) {
    throw new OrchestrationError(
      'archive_failed',
      `Output could not be preserved for Dispatch ${args.dispatchId}; the terminal was retained. ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const redacted = redactWorkerTerminalLines([
    ...terminal.tail,
    ...(terminal.draft ? [terminal.draft] : [])
  ])
  const bounded = boundArchiveLines(redacted.lines)
  const draft = terminal.draft ? bounded.lines.at(-1) : undefined
  const lines = terminal.draft ? bounded.lines.slice(0, -1) : bounded.lines
  // An exited PTY clears its tail; report empty evidence explicitly to worker-read.
  const empty = bounded.lines.every((line) => line.trim() === '')
  return {
    kind: 'terminal_tail',
    status: empty ? 'empty' : 'captured',
    content: {
      lines,
      ...(draft ? { draft } : {}),
      truncated: terminal.truncated || bounded.truncated,
      terminalStatus: terminal.status,
      warnings: empty
        ? [
            ...redacted.warnings,
            ...terminal.warnings,
            'The live terminal buffer was empty at release; structured transcript output was unavailable.'
          ]
        : [...redacted.warnings, ...terminal.warnings],
      fallbackReason: transcriptFallbackReason,
      clipping: [
        'terminal_fallback',
        ...(bounded.truncated || terminal.truncated ? ['terminal_buffer'] : [])
      ]
    }
  }
}

export function boundArchiveLines(lines: string[]): { lines: string[]; truncated: boolean } {
  let total = 0
  for (const line of lines) {
    total += line.length + 1
    if (total > TERMINAL_ARCHIVE_MAX_CHARS) {
      break
    }
  }
  if (total <= TERMINAL_ARCHIVE_MAX_CHARS) {
    return { lines, truncated: false }
  }
  // Collect newest-first and reverse once; per-line unshift is quadratic for ~260k blank lines.
  const keptReversed: string[] = []
  let budget = TERMINAL_ARCHIVE_MAX_CHARS
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const cost = lines[index].length + 1
    if (cost > budget) {
      if (keptReversed.length === 0 && budget > 1) {
        keptReversed.push(lines[index].slice(-(budget - 1)))
      }
      break
    }
    keptReversed.push(lines[index])
    budget -= cost
  }
  keptReversed.reverse()
  return { lines: keptReversed, truncated: true }
}

/** Errors at compile time if a capture kind is ever added that the durable row cannot store. */
type AssertAssignable<TValue extends TBound, TBound> = TValue
export type WorkerOutputArchiveCaptureKind = AssertAssignable<
  WorkerOutputArchiveCapture['kind'],
  WorkerTerminalArchiveKind
>

/** Archive fields a release commit records for an archive an earlier attempt already stored. */
export function releaseCommitFieldsForStoredArchive(archive: WorkerTerminalArchiveRow) {
  const stored = summarizeWorkerOutputArchive(archive)
  return { archiveSource: stored.source, archiveStatus: stored.status }
}

/** Archive fields a release commit publishes for freshly captured output. */
export function releaseCommitFieldsForCapturedArchive(captured: WorkerOutputArchiveCapture) {
  return {
    kind: captured.kind,
    content: JSON.stringify(captured.content),
    archiveSource:
      captured.kind === 'terminal_tail' ? ('terminal' as const) : ('transcript' as const),
    archiveStatus: captured.status
  }
}
