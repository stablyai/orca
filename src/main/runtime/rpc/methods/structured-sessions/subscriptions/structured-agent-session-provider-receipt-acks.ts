import type { AgentSessionProviderReceiptFrame } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import { AckProviderReceiptsParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-subscribe-params'
import { defineMethod, type RpcContext } from '../../../core'

type AwaitingReceiptAck = {
  connectionId: string | undefined
  revision: number
  release: () => void
}

const awaiting = new WeakMap<RpcContext['runtime'], Map<string, AwaitingReceiptAck>>()

/** IPC and the paired transports can enqueue synchronously even when their reader is stalled. */
export function sendProviderReceiptFrame(
  ctx: RpcContext,
  frame: AgentSessionProviderReceiptFrame,
  signal: AbortSignal,
  emit: (frame: AgentSessionProviderReceiptFrame) => void
): Promise<void> | undefined {
  if (signal.aborted) {
    return undefined
  }
  const pending = awaiting.get(ctx.runtime) ?? new Map<string, AwaitingReceiptAck>()
  awaiting.set(ctx.runtime, pending)
  const { promise, resolve } = Promise.withResolvers<void>()
  const { subscription, revision } = frame
  const release = (): void => {
    signal.removeEventListener('abort', release)
    pending.delete(subscription)
    resolve()
  }
  signal.addEventListener('abort', release, { once: true })
  pending.set(subscription, { connectionId: ctx.connectionId, revision, release })
  try {
    emit(frame)
  } catch (error) {
    release()
    throw error
  }
  return promise
}

export const STRUCTURED_AGENT_SESSION_ACK_PROVIDER_RECEIPTS = defineMethod({
  name: 'agentSession.ackProviderReceipts',
  permission: 'workspace',
  params: AckProviderReceiptsParams,
  handler: ({ subscription, revision }, ctx) => {
    const pending = awaiting.get(ctx.runtime)?.get(subscription)
    if (pending && pending.connectionId === ctx.connectionId && pending.revision === revision) {
      pending.release()
    }
    return {}
  }
})
