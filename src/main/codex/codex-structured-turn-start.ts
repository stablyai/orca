import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  isCodexAppServerRequestError,
  type CodexAppServerConnection
} from './codex-app-server-connection'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import type { CodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'
import { readCodexTurnId } from './codex-structured-thread-facts'

// Active-turn ownership is established by Codex atomically checking the expected
// turn. A fresh start needs both its response id and matching started event.

/** Keys Codex accepts as per-turn overrides. An unlisted key would otherwise
 *  become an arbitrary client-controlled `turn/start` parameter. */
const CODEX_TURN_OPTION_KEYS = new Set([
  'model',
  'effort',
  'approvalsReviewer',
  'personality',
  'serviceTier',
  'fastMode'
])

const CODEX_ACTIVE_TURN_SETTING_KEYS = new Set([
  'model',
  'effort',
  'summary',
  'approvalsReviewer',
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
  reportedOptions?: { model?: string }
  fastModeTierByModel: ReadonlyMap<string, string>
  dispatchEchoes: CodexDispatchEchoes
  activeTurnIds?: ReadonlySet<string>
}

function currentActiveTurnId(host: CodexTurnHost): string | null {
  let current: string | null = null
  for (const turnId of host.activeTurnIds ?? []) {
    current = turnId
  }
  return current
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

function steerProvesNoEnqueue(error: unknown): boolean {
  return isCodexAppServerRequestError(error) && error.method === 'turn/steer'
}

function activeTurnSettings(host: CodexTurnHost): Record<string, string> | null {
  const options = codexTurnOptions(host)
  return Object.keys(options).every((key) => CODEX_ACTIVE_TURN_SETTING_KEYS.has(key))
    ? options
    : null
}

function readSettingsUpdateStatus(result: unknown): 'applied' | 'targetUnavailable' | null {
  if (typeof result !== 'object' || result === null || !('status' in result)) {
    return null
  }
  return result.status === 'applied' || result.status === 'targetUnavailable' ? result.status : null
}

async function applyActiveTurnSettings(
  host: CodexTurnHost,
  turnId: string,
  timeoutMs: number | undefined
): Promise<boolean> {
  const settings = activeTurnSettings(host)
  if (settings === null) {
    return false
  }
  if (Object.keys(settings).length === 0) {
    return true
  }
  try {
    const result = await host.connection.request(
      'turn/settings/update',
      { threadId: host.threadId, turnId, ...settings },
      { timeoutMs }
    )
    return readSettingsUpdateStatus(result) === 'applied'
  } catch {
    // The settings request carries no user input, so a full-options start is safe.
    return false
  }
}

async function startFreshCodexTurn(
  host: CodexTurnHost,
  input: { clientMessageId: string; body: AgentJournalMessageItem; timeoutMs?: number }
): Promise<void> {
  const recordResponse = (result: unknown): void => {
    const turnId = readCodexTurnId(result)
    if (turnId) {
      host.dispatchEchoes.recordStartResponse(input.clientMessageId, turnId)
    }
  }
  const result = await host.connection.request(
    'turn/start',
    {
      threadId: host.threadId,
      clientUserMessageId: input.clientMessageId,
      input: turnInputFor(input.body),
      ...codexTurnOptions(host)
    },
    { timeoutMs: input.timeoutMs, onResult: recordResponse }
  )
  // Also covers test and alternate connections that omit the synchronous observer.
  recordResponse(result)
}

async function steerActiveCodexTurn(
  host: CodexTurnHost,
  expectedTurnId: string,
  input: { clientMessageId: string; body: AgentJournalMessageItem; timeoutMs?: number }
): Promise<void> {
  const bindResponse = (result: unknown): void => {
    const turnId = readCodexTurnId(result)
    if (turnId) {
      host.dispatchEchoes.bindSteerResponse(input.clientMessageId, expectedTurnId, turnId)
    }
  }
  const result = await host.connection.request(
    'turn/steer',
    {
      threadId: host.threadId,
      expectedTurnId,
      clientUserMessageId: input.clientMessageId,
      input: turnInputFor(input.body)
    },
    { timeoutMs: input.timeoutMs, onResult: bindResponse }
  )
  bindResponse(result)
}

/**
 * Hands one submission to Codex and binds its client id to the provider-owned turn.
 */
export async function startCodexTurn(
  host: CodexTurnHost,
  input: {
    clientMessageId: string
    body: AgentJournalMessageItem
    requestedAt?: number
    timeoutMs?: number
  }
): Promise<'admitted'> {
  // Armed before the write: the echo can land while the response is in flight.
  host.dispatchEchoes.arm(input.clientMessageId, input.requestedAt)
  const expectedOwnerTurnId = currentActiveTurnId(host)
  if (expectedOwnerTurnId) {
    if (await applyActiveTurnSettings(host, expectedOwnerTurnId, input.timeoutMs)) {
      try {
        await steerActiveCodexTurn(host, expectedOwnerTurnId, input)
        return 'admitted'
      } catch (error) {
        if (!steerProvesNoEnqueue(error) && !isCodexAppServerUnsupportedError(error)) {
          throw error
        }
      }
    }
    // No user input was enqueued. Reuse its correlation for a full-options start.
    host.dispatchEchoes.arm(input.clientMessageId, input.requestedAt)
  }
  await startFreshCodexTurn(host, input)
  return 'admitted'
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
  try {
    await startCodexTurn(session, { ...input, timeoutMs })
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
