import type { AgentSessionCancelResult } from '../../../src/shared/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import { runningStructuredAgentSessionTurnId } from '../../../src/shared/structured-agent-session-live-turn'
import type { RpcClient } from '../transport/rpc-client'
import {
  requestStructuredAgentSessionMutation,
  type StructuredAgentSessionMutationCallResult
} from './mobile-structured-agent-session-rpc'

type PromptIdentity = { itemId: string; expectedRevision: number }

export function pendingStructuredPromptIdentity(
  items: readonly AgentJournalRenderItem[]
): PromptIdentity | undefined {
  const prompt = items.find((item) =>
    item.body.kind === 'approval' || item.body.kind === 'question'
      ? item.body.resolution.state === 'pending'
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
  /** Stops still on their way, by what they stop; against a host that does not answer a repeat
   *  quietly, a press for the same one joins it here. */
  inFlight: Map<string, Promise<boolean>>
  onSendError: (message: string) => void
}): Promise<boolean> {
  const { client, enabled, inFlight, onSendError, sessionId, stateRef } = args
  const current = stateRef.current
  const turnId = runningStructuredAgentSessionTurnId(current)
  if (!client || !sessionId || !enabled || current.fence === null || !turnId) {
    onSendError('Stop not sent')
    return false
  }
  // Check the capability before fields enter the fingerprint.
  const fields = {
    turnId,
    ...(args.prompt && args.promptCancelSupported === true ? { prompt: args.prompt } : {})
  }
  // Every press is its own Stop: a kept id would be answered from the last one and stop nothing.
  const fence = current.fence
  const stop = () => sendStop({ client, sessionId, fence, fields, onSendError })
  if (args.hostAnswersRepeatedStops === true) {
    return stop()
  }
  // Temporary, for a host that predates the quiet repeated Stop: remove once none is supported.
  const key = `${sessionId}:agentSession.cancel:${JSON.stringify(fields)}`
  const joined = inFlight.get(key)
  if (joined) {
    return joined
  }
  const stopping = stop()
  inFlight.set(key, stopping)
  // Gone once it settles, so the next press is a new Stop.
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
