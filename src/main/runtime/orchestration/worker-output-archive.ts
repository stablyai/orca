import type { AgentType } from '../../../shared/native-chat-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationError } from './orchestration-error'
import { redactWorkerTerminalLines } from './worker-transcript-payload'
import { readWorkerTranscript } from './worker-transcript-read'

// Bound the durable copy of raw terminal output; the tail end is the evidence that matters.
const TERMINAL_ARCHIVE_MAX_CHARS = 262_144

export type WorkerTranscriptPinArchive = {
  agent: AgentType
  providerSessionKey: string
  providerSessionId: string
  transcriptPath: string | null
  processIncarnation: string
  observedAfter: number
  endOffset?: number
}

export type WorkerTerminalTailArchive = {
  lines: string[]
  truncated: boolean
  terminalStatus: string
  warnings: string[]
}

export type WorkerOutputArchiveCapture =
  | { kind: 'transcript_pin'; content: WorkerTranscriptPinArchive; status: 'captured' }
  | { kind: 'terminal_tail'; content: WorkerTerminalTailArchive; status: 'captured' | 'empty' }

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
  if (session) {
    const probe = await readWorkerTranscript({
      agent: session.agent,
      sessionId: session.providerSession.id,
      transcriptPath: session.providerSession.transcriptPath,
      limit: 1
    }).catch(() => null)
    if (probe?.ok) {
      return {
        kind: 'transcript_pin',
        status: 'captured',
        content: {
          agent: session.agent,
          providerSessionKey: session.providerSession.key,
          providerSessionId: session.providerSession.id,
          transcriptPath: session.providerSession.transcriptPath ?? null,
          processIncarnation: session.processIncarnation,
          observedAfter: args.attachedAtMs,
          endOffset: probe.nextOffset
        }
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
  const redacted = redactWorkerTerminalLines(terminal.tail)
  const bounded = boundArchiveLines(redacted.lines)
  // Why: an exited PTY zeroes its tail immediately, so an empty capture is a distinct receipt,
  // not silent success — worker-read must be able to say why nothing is there.
  const empty = bounded.lines.every((line) => line.trim() === '')
  return {
    kind: 'terminal_tail',
    status: empty ? 'empty' : 'captured',
    content: {
      lines: bounded.lines,
      truncated: terminal.truncated || bounded.truncated,
      terminalStatus: terminal.status,
      warnings: empty
        ? [
            ...redacted.warnings,
            'The live terminal buffer was empty at release; structured transcript output was unavailable.'
          ]
        : redacted.warnings
    }
  }
}

function boundArchiveLines(lines: string[]): { lines: string[]; truncated: boolean } {
  let total = 0
  for (const line of lines) {
    total += line.length + 1
  }
  if (total <= TERMINAL_ARCHIVE_MAX_CHARS) {
    return { lines, truncated: false }
  }
  const kept: string[] = []
  let budget = TERMINAL_ARCHIVE_MAX_CHARS
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const cost = lines[index].length + 1
    if (cost > budget) {
      if (kept.length === 0 && budget > 1) {
        kept.unshift(lines[index].slice(-(budget - 1)))
      }
      break
    }
    kept.unshift(lines[index])
    budget -= cost
  }
  return { lines: kept, truncated: true }
}
