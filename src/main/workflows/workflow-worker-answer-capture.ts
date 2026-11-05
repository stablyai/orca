import type { NativeChatMessage } from '../../shared/native-chat/native-chat-types'
import type { WorkflowWorkerAnswer } from '../../shared/workflow/workflow-run-types'
import { isWslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { replaceDispatchCapabilities } from '../runtime/orchestration/worker-terminal-redaction'
import { MAX_WORKER_TRANSCRIPT_MESSAGE_LIMIT } from '../runtime/orchestration/worker-transcript-payload'
import { readWorkerTranscript } from '../runtime/orchestration/worker-transcript-read'
import { record } from './workflow-orca-receipts'

const MAX_ANSWER_CHARS = 64_000
const TERMINAL_ANSWER_LINES = 400

export type CapturedWorkflowAnswer = Omit<WorkflowWorkerAnswer, 'capturedAt'>

function assistantText(messages: readonly NativeChatMessage[]): string {
  return messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) =>
      message.blocks.flatMap((block) => (block.type === 'text' ? [block.text.trim()] : []))
    )
    .filter(Boolean)
    .join('\n\n')
}

function bounded(
  source: CapturedWorkflowAnswer['source'],
  raw: string,
  omittedEarlier: boolean
): CapturedWorkflowAnswer | null {
  const { value } = replaceDispatchCapabilities(raw.trim())
  if (!value) {
    return null
  }
  // The final answer sits at the end, so overflow drops the start.
  const over = value.length > MAX_ANSWER_CHARS
  return {
    source,
    text: over ? value.slice(-MAX_ANSWER_CHARS) : value,
    truncated: over || omittedEarlier
  }
}

/** The agent's own session log, read whole; null when this host cannot reach it. */
async function readTranscriptAnswer(
  runtime: OrcaRuntimeService,
  terminalHandle: string,
  startedAtMs: number
): Promise<CapturedWorkflowAnswer | null> {
  const session = runtime.getExactWorkerProviderSession(terminalHandle, startedAtMs)
  if (!session) {
    return null
  }
  const isWsl = isWslHookRelayConnectionId(session.connectionId)
  // No SSH filesystem provider is installed, so remote transcripts are unreachable.
  if ((isWsl && !session.wslDistro) || (session.connectionId && !isWsl)) {
    return null
  }
  const transcript = await readWorkerTranscript({
    agent: session.agent,
    sessionId: session.providerSession.id,
    transcriptPath: session.providerSession.transcriptPath,
    wslDistro: session.wslDistro,
    limit: MAX_WORKER_TRANSCRIPT_MESSAGE_LIMIT,
    clip: false
  })
  return transcript.ok
    ? bounded('transcript', assistantText(transcript.messages), transcript.limited)
    : null
}

/** What a workflow worker wrote, from its transcript when readable, else its terminal screen. */
export async function captureWorkflowWorkerAnswer(args: {
  runtime: OrcaRuntimeService
  readTerminal: (dispatchId: string, lines: number) => Promise<unknown>
  orcaDispatchId: string
  terminalHandle: string | null
  startedAtMs: number
}): Promise<CapturedWorkflowAnswer | null> {
  if (args.terminalHandle) {
    const fromTranscript = await readTranscriptAnswer(
      args.runtime,
      args.terminalHandle,
      args.startedAtMs
    ).catch(() => null)
    if (fromTranscript) {
      return fromTranscript
    }
  }
  // worker-read redacts, and still answers from the archive once the terminal is released.
  const terminal = record(
    record(await args.readTerminal(args.orcaDispatchId, TERMINAL_ANSWER_LINES)).terminal
  )
  const tail = Array.isArray(terminal.tail)
    ? terminal.tail.filter((line): line is string => typeof line === 'string')
    : []
  return bounded('terminal', tail.join('\n'), terminal.truncated === true)
}
