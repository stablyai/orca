import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  isCodexAppServerRequestError,
  type CodexAppServerConnection
} from './codex-app-server-connection'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import type { CodexDispatchEchoes } from './codex-structured-dispatch-echo'

// Writing a Codex turn and learning which message landed where, which are not
// the same event. `turn/start` answers as soon as Codex owns the message, but a
// message issued while a turn is running is COALESCED into that turn: the same
// turn id comes back, no second `turn/started` fires, and the user message is
// echoed only when the running turn reaches it. So the response proves
// admission and nothing about identity, which the echo settles later.

/** Keys Codex accepts as per-turn overrides. An unlisted key would otherwise
 *  become an arbitrary client-controlled `turn/start` parameter. */
const CODEX_TURN_OPTION_KEYS = new Set([
  'model',
  'effort',
  'approvalPolicy',
  'approvalsReviewer',
  'personality',
  'serviceTier'
])

export function isCodexTurnOptionKey(key: string): boolean {
  return CODEX_TURN_OPTION_KEYS.has(key)
}

/** The session state one turn needs. */
export type CodexTurnHost = {
  connection: Pick<CodexAppServerConnection, 'request'>
  threadId: string
  options: Map<string, string>
  dispatchEchoes: CodexDispatchEchoes
}

function turnInputFor(body: AgentJournalMessageItem): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = []
  for (const block of body.blocks as NativeChatBlock[]) {
    if (block.type === 'text' && block.text.length > 0) {
      input.push({ type: 'text', text: block.text })
    } else if (block.type === 'image-ref' && block.path) {
      input.push({ type: 'localImage', path: block.path })
    } else if (block.type === 'image-ref' && block.url) {
      input.push({ type: 'image', url: block.url })
    }
  }
  return input
}

/**
 * Hands one submission to Codex. False means the bounded correlation window
 * refused it before the write; otherwise resolves when Codex has taken it.
 */
export async function startCodexTurn(
  host: CodexTurnHost,
  input: { clientMessageId: string; body: AgentJournalMessageItem; timeoutMs?: number }
): Promise<boolean> {
  // Armed before the write: the echo can land while the response is in flight.
  if (!host.dispatchEchoes.arm(input.clientMessageId)) {
    return false
  }
  await host.connection.request(
    'turn/start',
    {
      threadId: host.threadId,
      clientUserMessageId: input.clientMessageId,
      input: turnInputFor(input.body),
      ...Object.fromEntries(host.options)
    },
    { timeoutMs: input.timeoutMs }
  )
  return true
}

/**
 * One submission's outcome as the wire must read it: admitted means Codex owns
 * the message and its identity settles on the echo, rejected is Codex answering
 * and declining. Elapsed time is never evidence here, because the wait a
 * coalesced send would face is bounded only by the running turn.
 */
export async function dispatchCodexTurn(
  session: CodexTurnHost,
  input: { clientMessageId: string; body: AgentJournalMessageItem },
  timeoutMs: number | undefined
): Promise<AgentSessionDispatchOutcome> {
  try {
    if (!(await startCodexTurn(session, { ...input, timeoutMs }))) {
      return { state: 'rejected', reason: 'codex structured dispatch queue is full' }
    }
  } catch (error) {
    if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
      // Codex answered and declined, so no echo for this write can arrive.
      session.dispatchEchoes.disarm(input.clientMessageId)
      return { state: 'rejected', reason: (error as Error).message }
    }
    // A timeout or transport failure can happen after the frame was written.
    // Keep the correlation armed so a later echo can prove delivery.
    throw error
  }
  return { state: 'admitted' }
}
