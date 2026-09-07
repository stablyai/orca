import type { AgentType, NativeChatMessage } from '../../../shared/native-chat-types'
import type { OrchestrationWorkerReadFallbackReason } from '../../../shared/orchestration-worker-output'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationError } from './orchestration-error'
import type {
  WorkerTerminalArchiveRow,
  WorkerTerminalArchiveStatus
} from './worker-terminal-ownership'
import {
  MAX_WORKER_TRANSCRIPT_MESSAGE_LIMIT,
  redactWorkerTerminalLines
} from './worker-transcript-payload'
import { readWorkerTranscript } from './worker-transcript-read'
import { getSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import { isWslHookRelayConnectionId } from '../../../shared/wsl-hook-relay-contract'

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
  | { kind: 'terminal_tail'; content: WorkerTerminalTailArchive; status: 'captured' | 'empty' }

export function summarizeWorkerOutputArchive(archive: WorkerTerminalArchiveRow): {
  source: 'transcript' | 'terminal'
  status: Extract<WorkerTerminalArchiveStatus, 'captured' | 'empty'>
} {
  if (archive.kind === 'transcript_pin') {
    return { source: 'transcript', status: 'captured' }
  }
  const content = JSON.parse(archive.content) as WorkerTerminalTailArchive
  const empty =
    content.lines.every((line) => line.trim() === '') && (content.draft?.trim() ?? '') === ''
  return {
    source: 'terminal',
    status: empty ? 'empty' : 'captured'
  }
}

// Freezes an inspectable output source before the live PTY is closed. Prefers the exact
// hook-reported provider transcript; falls back to bounded redacted terminal output. Throws
// typed archive_failed so release retains the live terminal when no evidence can be preserved.
export async function captureWorkerOutputArchive(args: {
  runtime: OrcaRuntimeService
  dispatchId: string
  terminalHandle: string
  attachedAtMs: number
}): Promise<WorkerOutputArchiveCapture> {
  const session = args.runtime.getExactWorkerProviderSession(args.terminalHandle, args.attachedAtMs)
  let transcriptFallbackReason: OrchestrationWorkerReadFallbackReason = 'session_not_reported'
  if (session) {
    transcriptFallbackReason = 'transcript_unreadable'
    const isWslSession = isWslHookRelayConnectionId(session.connectionId)
    const remoteConnectionId = session.connectionId && !isWslSession ? session.connectionId : null
    const remoteFilesystemProvider = remoteConnectionId
      ? getSshFilesystemProvider(remoteConnectionId)
      : undefined
    if ((isWslSession && !session.wslDistro) || (remoteConnectionId && !remoteFilesystemProvider)) {
      transcriptFallbackReason = 'remote_capability_unavailable'
    } else {
      const snapshot = await readWorkerTranscript({
        agent: session.agent,
        sessionId: session.providerSession.id,
        transcriptPath: session.providerSession.transcriptPath,
        wslDistro: session.wslDistro,
        limit: MAX_WORKER_TRANSCRIPT_MESSAGE_LIMIT,
        filesystemProvider: remoteFilesystemProvider
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
    terminal = await args.runtime.readTerminal(args.terminalHandle, {})
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
  // Why: an exited PTY zeroes its tail immediately, so an empty capture is a distinct receipt,
  // not silent success — worker-read must be able to say why nothing is there.
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
            'The live terminal buffer was empty at release; structured transcript output was unavailable.'
          ]
        : redacted.warnings,
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
  }
  if (total <= TERMINAL_ARCHIVE_MAX_CHARS) {
    return { lines, truncated: false }
  }
  // Collected newest-first and reversed once: unshift per line is O(n^2) and the
  // char budget admits ~260k blank lines.
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
