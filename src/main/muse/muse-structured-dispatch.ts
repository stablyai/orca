import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { mspItemIdentity } from './msp-journal-translation'
import { mspTurnParts, type MspDispatchInput } from './msp-dispatch-input'
import { applyMuseExecutionOptions, museRejected } from './muse-structured-session-options'
import type { MspLiveSession } from './muse-structured-live-session'

export type MuseDispatchRequest = {
  sessionId: string
  clientMessageId: string
  requestedAt?: number
  body: { blocks: NativeChatBlock[] }
  executionOptions?: { model?: string; effort?: string }
  signal?: AbortSignal
  onInputPreparation?: () => void
  beforeDispatch?: () => Promise<void> | void
  now?: () => number
}

export async function dispatchMuseTurn(
  live: MspLiveSession,
  input: MuseDispatchRequest
): Promise<AgentSessionDispatchOutcome> {
  const at = input.now ?? Date.now
  const dispatchInput: MspDispatchInput = []
  const textParts: string[] = []
  for (const block of input.body.blocks) {
    if (block.type === 'text') {
      textParts.push(block.text)
      continue
    }
    if (block.type === 'image-ref' && typeof block.path === 'string') {
      dispatchInput.push({ path: block.path })
      continue
    }
    return museRejected(`cannot send ${block.type} blocks in a structured chat`)
  }
  if (textParts.length > 0) {
    dispatchInput.unshift({ text: textParts.join('\n\n') })
  }
  if (dispatchInput.length === 0) {
    return museRejected('sent an empty message')
  }
  try {
    await mspTurnParts(dispatchInput)
  } catch (error) {
    return museRejected(error instanceof Error ? error.message : String(error))
  }
  input.signal?.throwIfAborted()
  input.onInputPreparation?.()
  let ranOptions: Record<string, string> = {}
  try {
    ranOptions = await applyMuseExecutionOptions(live, input.executionOptions)
  } catch (error) {
    return museRejected(error instanceof Error ? error.message : String(error))
  }
  input.signal?.throwIfAborted()
  await input.beforeDispatch?.()
  input.signal?.throwIfAborted()
  let turnId: string
  try {
    turnId = await live.msp.startTurn(dispatchInput)
  } catch (error) {
    return museRejected(error instanceof Error ? error.message : String(error))
  }
  live.turnId = turnId
  live.pendingTurn = {
    clientMessageId: input.clientMessageId,
    requestedAt: input.requestedAt ?? at()
  }
  const userIdentity = mspItemIdentity(input.sessionId, `user:${input.clientMessageId}`)
  live.translator.writeUserMessage(input.clientMessageId, input.body.blocks, turnId)
  live.translator.openTurn(turnId, {
    requestedAt: input.requestedAt ?? at(),
    userItemId: agentJournalItemKey(userIdentity)
  })
  return {
    state: 'accepted',
    providerIdentity: mspItemIdentity(input.sessionId, `turn:${turnId}`),
    ...(Object.keys(ranOptions).length > 0 ? { ranOptions } : {})
  }
}
