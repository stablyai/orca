import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  isCodexAppServerRequestError,
  type CodexAppServerConnection
} from './codex-app-server-connection'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import {
  armCodexEchoTimeout,
  discardCodexEchoWaiter,
  registerCodexEchoWaiter,
  retireCodexEchoWaiter,
  type CodexDispatchEchoes
} from './codex-structured-dispatch-echo'
import { readCodexTurnId } from './codex-structured-thread-facts'

// Starting a Codex turn and learning its id, which are not the same event:
// `turn/start` returns the id on newer builds and acks before it exists on
// older ones, where it arrives as a `turn/started` notification instead.

/** Fallback ordinal for the sole message that opened a fresh turn — provably
 *  its first message. Coalesced sends must never use it; their true ordinal
 *  comes from the `userMessage` echo. */
export const CODEX_USER_MESSAGE_ORDINAL = 0

/** Past this the turn is real but unnameable, which the journal renders as
 *  delivery unconfirmed rather than failure. */
const TURN_ID_WAIT_MS = 10_000

/** Fresh-turn echo grace. Measured on codex-cli 0.153.4: turn/start ack →
 *  userMessage echo ≈ +1.73s for a fresh turn. Old builds never echo, so this
 *  also bounds their added send latency before the positional fallback. */
const CODEX_ECHO_ACK_WINDOW_MS = 2_500

/** Echo window when the request timeout is unset; mirrors the connection's
 *  default request timeout. */
const CODEX_DISPATCH_ECHO_TIMEOUT_MS = 30_000

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
  /** Turns this session believes are running; classifies coalesced re-sends. */
  activeTurnIds: Set<string>
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
 * Resolves the turn id, or null when Codex owns a turn it never named, plus
 * whether this dispatch's own `turn/started` notification named it — freshness
 * evidence, since a coalesced start emits none. Throws only for outcomes the
 * wire must not read as acceptance.
 */
export async function startCodexTurn(
  host: CodexTurnHost,
  input: { clientMessageId: string; body: AgentJournalMessageItem; timeoutMs?: number }
): Promise<{
  turnId: string | null
  readonly startedNotificationObserved: boolean
  dispose: () => void
}> {
  // Registered BEFORE the call: on builds that ack first, `turn/started` can
  // land while the response is still in flight.
  let notifiedTurnId: string | null = null
  let notified: ((turnId: string) => void) | null = null
  let notificationTimer: ReturnType<typeof setTimeout> | undefined
  const fromNotification = new Promise<string | null>((resolve) => {
    notified = (turnId: string) => {
      notifiedTurnId = turnId
      resolve(turnId)
    }
    host.turnIdWaiters.push(notified)
    notificationTimer = setTimeout(() => resolve(null), TURN_ID_WAIT_MS)
    notificationTimer.unref?.()
  })
  const dispose = (): void => {
    clearTimeout(notificationTimer)
    const index = notified ? host.turnIdWaiters.indexOf(notified) : -1
    if (index !== -1) {
      host.turnIdWaiters.splice(index, 1)
    }
  }
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
    const turnId = readCodexTurnId(started) ?? (await fromNotification)
    return {
      turnId,
      get startedNotificationObserved() {
        return notifiedTurnId !== null && notifiedTurnId === turnId
      },
      dispose
    }
  } catch (error) {
    dispose()
    throw error
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
  timeoutMs: number | undefined,
  echoAckWindowMs: number = CODEX_ECHO_ACK_WINDOW_MS
): Promise<AgentSessionDispatchOutcome> {
  // Registered BEFORE `turn/start`: the echo can race the response.
  const echo = registerCodexEchoWaiter(session.dispatchEchoes, input.clientMessageId)
  let started: Awaited<ReturnType<typeof startCodexTurn>>
  try {
    started = await startCodexTurn(session, { ...input, timeoutMs })
  } catch (error) {
    discardCodexEchoWaiter(session.dispatchEchoes, echo.waiter)
    if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
      return { state: 'rejected', reason: (error as Error).message }
    }
    throw error
  }
  try {
    const { turnId } = started
    // THE CRUX. Codex coalesces a `turn/start` issued while a turn runs into the
    // RUNNING turn: same id back, and no second `turn/started`. So a response
    // naming a turn already in flight is a coalesced send whose message is NOT
    // ordinal 0. An observed `turn/started` overrides: on builds that ack before
    // naming, the fresh turn's own notification lands first and would otherwise
    // read as "already in flight".
    const coalesced =
      turnId !== null && !started.startedNotificationObserved && session.activeTurnIds.has(turnId)
    const fullWindowMs = timeoutMs ?? CODEX_DISPATCH_ECHO_TIMEOUT_MS
    // A coalesced echo is deferred until the running turn yields (measured
    // +6.15s), so it gets the full request window — the outbox honestly renders
    // 'dispatching' meanwhile. A fresh turn's echo lands fast or never (old
    // builds), so it gets only a short grace before the positional fallback.
    armCodexEchoTimeout(
      session.dispatchEchoes,
      echo.waiter,
      coalesced || turnId === null ? fullWindowMs : Math.min(echoAckWindowMs, fullWindowMs)
    )
    const identity = await echo.promise
    if (identity) {
      return { state: 'accepted', providerIdentity: identity }
    }
    if (turnId === null) {
      retireCodexEchoWaiter(session.dispatchEchoes, echo.waiter)
      return { state: 'unknown', reason: 'codex app-server started a turn it did not name in time' }
    }
    if (
      started.startedNotificationObserved &&
      !session.dispatchEchoes.sawClientIdEcho &&
      session.dispatchEchoes.waiters.length === 0 &&
      session.dispatchEchoes.retired.length === 0
    ) {
      // Old-build compatibility: no echo will come, and the sole message that
      // opened a fresh turn is provably its ordinal 0 — exactly today's identity.
      return {
        state: 'accepted',
        providerIdentity: {
          provider: 'codex',
          threadId: session.threadId,
          turnId,
          ordinal: CODEX_USER_MESSAGE_ORDINAL
        }
      }
    }
    retireCodexEchoWaiter(session.dispatchEchoes, echo.waiter)
    return { state: 'unknown', reason: 'codex accepted a message but did not echo it in time' }
  } finally {
    started.dispose()
  }
}
