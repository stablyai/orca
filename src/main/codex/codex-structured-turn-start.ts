import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  isCodexAppServerRequestError,
  type CodexAppServerConnection
} from './codex-app-server-connection'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import type { CodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { readCodexTurnId } from './codex-structured-thread-facts'
import {
  codexRunningOrOpeningTurn,
  type CodexTurnOpenWaits
} from './codex-structured-turn-open-wait'
import {
  codexDispatchRejection,
  codexTurnEndRejection
} from './codex-structured-turn-end-settlement'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'

// Writing a Codex turn and learning which message landed where, which are not
// the same event. The answer proves admission and nothing about identity, which
// the echo settles later; the turn it names is kept with the send, so that
// turn's end can settle it. A message sent while a turn is running goes in as
// `turn/steer` naming that turn, so the answer names the turn that carries it.
// `turn/start` would also steer it, with no second `turn/started`, but a Codex
// before 0.148 answers that with an id no turn ever opens or ends under. So a send
// made after Codex answered an earlier one, before it opened that turn, waits for
// the turn to open and steers it.

/** Keys Codex accepts as per-turn overrides. An unlisted key would otherwise
 *  become an arbitrary client-controlled `turn/start` parameter. Permission posture is owned by
 *  Agent Permissions and applied when the thread opens. */
const CODEX_TURN_OPTION_KEYS = new Set([
  'model',
  'effort',
  'approvalsReviewer',
  'personality',
  'serviceTier',
  'fastMode'
])

export function isCodexTurnOptionKey(key: string): boolean {
  return CODEX_TURN_OPTION_KEYS.has(key)
}

/** The session state one turn needs. */
export type CodexTurnHost = {
  connection: Pick<CodexAppServerConnection, 'request'>
  threadId: string
  options: Map<string, string>
  reportedOptions?: { model?: string }
  fastModeTierByModel: ReadonlyMap<string, string>
  dispatchEchoes: CodexDispatchEchoes
  activeTurnIds?: ReadonlySet<string>
  turnOpenWaits: Pick<CodexTurnOpenWaits, 'wait'>
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

function codexTurnOptions(host: CodexTurnHost): Record<string, string> {
  const options = Object.fromEntries(
    [...host.options].filter(([key]) => key !== 'fastMode' && key !== 'serviceTier')
  )
  const encodedFastMode = host.options.get('fastMode')
  if (encodedFastMode === undefined) {
    return options
  }
  const fastMode = decodeStructuredAgentSessionOptionValue('fastMode', encodedFastMode)
  if (typeof fastMode !== 'boolean') {
    throw new Error('codex fast mode must be encoded as true or false')
  }
  if (!fastMode) {
    return { ...options, serviceTier: 'default' }
  }
  const model = host.options.get('model') ?? host.reportedOptions?.model
  const tierId = model ? host.fastModeTierByModel.get(model) : undefined
  // Fast is on but nothing has named the tier for this model yet, so there is no
  // value to route to. Deliberately Standard rather than an omission: the tier
  // persists on the thread, so omitting would silently keep routing a paid tier we
  // cannot currently name, and discovery recovers the exact tier on a later turn.
  if (!tierId) {
    return { ...options, serviceTier: 'default' }
  }
  return { ...options, serviceTier: tierId }
}

/**
 * Steers a send into the turn Codex last reported running. Null when Codex refused the steer,
 * which it does before taking any input: that turn ended or changed, it cannot be steered, or
 * this Codex has no `turn/steer`. Per-turn options ride on the next `turn/start`.
 */
async function steerCodexTurn(
  host: CodexTurnHost,
  expectedTurnId: string,
  input: { clientMessageId: string; body: AgentJournalMessageItem; timeoutMs?: number }
): Promise<{ turnId: string } | null> {
  try {
    const answer = await host.connection.request(
      'turn/steer',
      {
        threadId: host.threadId,
        expectedTurnId,
        clientUserMessageId: input.clientMessageId,
        input: turnInputFor(input.body)
      },
      { timeoutMs: input.timeoutMs }
    )
    return { turnId: readCodexTurnId(answer) ?? expectedTurnId }
  } catch (error) {
    if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
      return null
    }
    throw error
  }
}

/**
 * Hands one submission to Codex. False means the bounded correlation window
 * refused it before the write; otherwise resolves with the turn Codex answered
 * it into, or null when the answer named none.
 */
export async function startCodexTurn(
  host: CodexTurnHost,
  input: {
    clientMessageId: string
    body: AgentJournalMessageItem
    requestedAt?: number
    timeoutMs?: number
  }
): Promise<{ turnId: string | null } | false> {
  // Armed before the write: the echo and `turn/started` can both land while the
  // response is in flight, and the start must snapshot this send in its frontier.
  if (!host.dispatchEchoes.arm(input.clientMessageId, input.requestedAt)) {
    return false
  }
  const runningTurnId = await codexRunningOrOpeningTurn(host)
  let steered = runningTurnId ? await steerCodexTurn(host, runningTurnId, input) : null
  // Refused because a turn Orca heard of meanwhile is running: steer that one, once.
  const runningSince = steered ? undefined : [...(host.activeTurnIds ?? [])].at(-1)
  if (runningSince && runningSince !== runningTurnId) {
    steered = await steerCodexTurn(host, runningSince, input)
  }
  if (steered) {
    return steered
  }
  const answer = await host.connection.request(
    'turn/start',
    {
      threadId: host.threadId,
      clientUserMessageId: input.clientMessageId,
      input: turnInputFor(input.body),
      ...codexTurnOptions(host)
    },
    { timeoutMs: input.timeoutMs }
  )
  return { turnId: readCodexTurnId(answer) }
}

/**
 * One submission's outcome as the wire must read it: admitted means Codex owns
 * the message and its identity settles on the echo, rejected is Codex answering
 * and declining. Elapsed time is never evidence here, because the wait a
 * steered send would face is bounded only by the running turn.
 */
export async function dispatchCodexTurn(
  session: CodexTurnHost,
  input: { clientMessageId: string; body: AgentJournalMessageItem; requestedAt?: number },
  timeoutMs: number | undefined
): Promise<AgentSessionDispatchOutcome> {
  let answer: { turnId: string | null } | false
  try {
    answer = await startCodexTurn(session, { ...input, timeoutMs })
  } catch (error) {
    if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
      // Codex answered and declined, so no echo for this write can arrive.
      session.dispatchEchoes.disarm(input.clientMessageId)
      // Codex's own words, when it gave any, are the one part of the error a person can use.
      return {
        state: 'rejected',
        ...codexDispatchRejection(
          agentSessionFailureFact('providerRejected', { detail: providerDiagnosticOf(error) })
        )
      }
    }
    // A timeout or transport failure can happen after the frame was written.
    // Keep the correlation armed so a later echo can prove delivery.
    throw error
  }
  if (!answer) {
    return { state: 'rejected', ...codexDispatchRejection(agentSessionFailureFact('queueFull')) }
  }
  // An answer read after the turn it names already ended is settled by that end.
  const endedFirst = answer.turnId
    ? session.dispatchEchoes.bindTurn(input.clientMessageId, session.threadId, answer.turnId)
    : null
  const rejection = endedFirst ? codexTurnEndRejection(endedFirst) : null
  return rejection ? { state: 'rejected', ...rejection } : { state: 'admitted' }
}
