import { selectAgentSessionCurrentRequests } from '../../../src/shared/agent-session-current-requests'
import type { AgentSessionCancelResult } from '../../../src/shared/agent-session-wire'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import {
  isActionableStructuredAgentSessionPrompt,
  runningStructuredAgentSessionTurnId
} from '../../../src/shared/structured-agent-session-live-turn'
import type { RpcClient } from '../transport/rpc-client'
import {
  requestStructuredAgentSessionMutation,
  type StructuredAgentSessionMutationCallResult
} from './mobile-structured-agent-session-rpc'

type PromptIdentity = { itemId: string; expectedRevision: number }

export function pendingStructuredPromptIdentity(
  state: Pick<StructuredAgentSessionState, 'items' | 'currentRequests' | 'actionablePromptIds'>
): PromptIdentity | undefined {
  const prompt = selectAgentSessionCurrentRequests(state).find((item) =>
    item.body.kind === 'approval' || item.body.kind === 'question'
      ? item.body.resolution.state === 'pending' &&
        isActionableStructuredAgentSessionPrompt(item.itemId, state.actionablePromptIds)
      : false
  )
  return prompt ? { itemId: prompt.itemId, expectedRevision: prompt.revision } : undefined
}

export async function requestMobileStructuredAgentSessionCancel(args: {
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  stateRef: { readonly current: StructuredAgentSessionState }
  promptCancelSupported: boolean | null
  prompt?: PromptIdentity
  /** Whether the host answers a repeated Stop of a turn quietly; null until the status probe answers. */
  hostAnswersRepeatedStops: boolean | null
  /** Whether the host takes a Stop naming no turn; null until the status probe answers. */
  hostStopsConversation: boolean | null
  // Join in-flight repeats only on legacy hosts that cannot quietly answer repeated Stop.
  inFlight: Map<string, Promise<boolean>>
  onSendError: (message: string) => void
}): Promise<boolean> {
  const { client, enabled, inFlight, onSendError, sessionId, stateRef } = args
  const current = stateRef.current
  const turnId = runningStructuredAgentSessionTurnId(current)
  // Check the capability before fields enter the fingerprint.
  const prompt = args.prompt && args.promptCancelSupported === true ? args.prompt : undefined
  // Conversation Stop also covers un-echoed sends; card Cancel must still name its originating turn.
  const unnamed = args.hostStopsConversation === true && !args.prompt
  if (!client || !sessionId || !enabled || current.fence === null || (!turnId && !unnamed)) {
    onSendError('Stop not sent')
    return false
  }
  const fields = unnamed ? {} : { turnId, ...(prompt ? { prompt } : {}) }
  // Mint an id for each Stop so the ledger cannot replay an earlier press instead of stopping work.
  const fence = current.fence
  const stop = () => sendStop({ client, sessionId, fence, fields, onSendError })
  if (args.hostAnswersRepeatedStops === true) {
    return stop()
  }
  // Legacy hosts need client-side joining until they support quiet repeated Stop.
  const key = `${sessionId}:agentSession.cancel:${JSON.stringify(fields)}`
  const joined = inFlight.get(key)
  if (joined) {
    return joined
  }
  const stopping = stop()
  inFlight.set(key, stopping)
  void stopping.finally(() => {
    if (inFlight.get(key) === stopping) {
      inFlight.delete(key)
    }
  })
  return stopping
}

async function sendStop(input: {
  client: RpcClient
  sessionId: string
  fence: number
  fields: Record<string, unknown>
  onSendError: (message: string) => void
}): Promise<boolean> {
  const result: StructuredAgentSessionMutationCallResult<AgentSessionCancelResult> =
    await requestStructuredAgentSessionMutation<AgentSessionCancelResult>({
      client: input.client,
      method: 'agentSession.cancel',
      fingerprintMethod: 'agentSession.cancel',
      sessionId: input.sessionId,
      expectedRuntimeFence: input.fence,
      fields: input.fields
    })
  if (result.status === 'accepted') {
    return true
  }
  if (result.status === 'unknown') {
    input.onSendError('Stop unconfirmed — check chat before retrying')
  } else if (result.status === 'refused') {
    input.onSendError(result.message)
  } else if (result.status === 'failed') {
    input.onSendError(result.message)
  }
  return false
}
