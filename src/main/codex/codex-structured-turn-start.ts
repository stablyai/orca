import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  isCodexAppServerRequestError,
  type CodexAppServerConnection
} from './codex-app-server-connection'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import { readCodexTurnId } from './codex-structured-thread-facts'

// Starting a Codex turn and learning its id, which are not the same event:
// `turn/start` returns the id on newer builds and acks before it exists on
// older ones, where it arrives as a `turn/started` notification instead.

/** Codex records the user message first in a turn, so the submission Orca just
 *  accepted is ordinal 0 of `(threadId, turnId)`. */
export const CODEX_USER_MESSAGE_ORDINAL = 0

/** Past this the turn is real but unnameable, which the journal renders as
 *  delivery unconfirmed rather than failure. */
const TURN_ID_WAIT_MS = 10_000

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

/** The session state one turn needs. `turnIdWaiters` is shared with the
 *  notification handler, which resolves the head of the queue — correct because
 *  Codex runs one turn per thread, so starts and `turn/started` share an order. */
export type CodexTurnHost = {
  connection: Pick<CodexAppServerConnection, 'request'>
  threadId: string
  options: Map<string, string>
  turnIdWaiters: ((turnId: string) => void)[]
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
 * Resolves the turn id, or null when Codex owns a turn it never named. Throws
 * only for outcomes the wire must not read as acceptance.
 */
export async function startCodexTurn(
  host: CodexTurnHost,
  input: { clientMessageId: string; body: AgentJournalMessageItem; timeoutMs?: number }
): Promise<string | null> {
  // Registered BEFORE the call: on builds that ack first, `turn/started` can
  // land while the response is still in flight.
  let notified: ((turnId: string) => void) | null = null
  const fromNotification = new Promise<string | null>((resolve) => {
    notified = resolve
    host.turnIdWaiters.push(resolve)
    setTimeout(() => resolve(null), TURN_ID_WAIT_MS).unref?.()
  })
  try {
    const started = await host.connection.request(
      'turn/start',
      {
        threadId: host.threadId,
        clientUserMessageId: input.clientMessageId,
        input: turnInputFor(input.body),
        ...Object.fromEntries(host.options)
      },
      { timeoutMs: input.timeoutMs }
    )
    return readCodexTurnId(started) ?? (await fromNotification)
  } finally {
    const index = notified ? host.turnIdWaiters.indexOf(notified) : -1
    if (index !== -1) {
      host.turnIdWaiters.splice(index, 1)
    }
  }
}

/**
 * One submission's outcome as the wire must read it: accepted names the turn,
 * rejected is Codex answering and declining, and unknown covers a turn that is
 * real but unnameable — never a failure the user is told their message hit.
 */
export async function dispatchCodexTurn(
  session: CodexTurnHost,
  input: { clientMessageId: string; body: AgentJournalMessageItem },
  timeoutMs: number | undefined
): Promise<AgentSessionDispatchOutcome> {
  let turnId: string | null
  try {
    turnId = await startCodexTurn(session, { ...input, timeoutMs })
  } catch (error) {
    if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
      return { state: 'rejected', reason: (error as Error).message }
    }
    throw error
  }
  return turnId === null
    ? { state: 'unknown', reason: 'codex app-server started a turn it did not name in time' }
    : {
        state: 'accepted',
        providerIdentity: {
          provider: 'codex',
          threadId: session.threadId,
          turnId,
          ordinal: CODEX_USER_MESSAGE_ORDINAL
        }
      }
}
