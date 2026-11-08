import { useMemo } from 'react'
import * as z from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { RpcClient } from '../transport/rpc-client'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'

const sendRecordedRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agentSession.sendRecorded',
    method: 'agentSession.sendRecorded',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('structured-send-recorded', z.object({ recorded: z.boolean() }))
  })
)

const REQUEST_OPTIONS = { timeoutMs: 10_000, budgetSpansConnect: true }

/** Whether the host recorded a send its loaded pages don't show; any failure is "not proven". */
function readMobileStructuredSendRecorded(
  client: RpcClient,
  sessionId: string,
  clientMessageId: string
): Promise<boolean> {
  return sendRecordedRead
    .request(client, { sessionId, clientMessageId }, REQUEST_OPTIONS)
    .then((reply) => sendRecordedRead.interpret(reply)?.recorded === true)
    .catch(() => false)
}

/** Null where the host can confirm a send only through the history pages the phone loaded. */
export function useMobileStructuredSendRecorded(
  client: RpcClient | null,
  sessionId: string | null,
  hostSupport: StructuredAgentSessionHostSupport | null | undefined
): ((clientMessageId: string) => Promise<boolean>) | null {
  const supported = hostSupport?.sendRecorded === true
  return useMemo(
    () =>
      client && sessionId && supported
        ? (clientMessageId: string) =>
            readMobileStructuredSendRecorded(client, sessionId, clientMessageId)
        : null,
    [client, sessionId, supported]
  )
}
