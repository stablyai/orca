import { useLayoutEffect, useMemo, useRef } from 'react'
import * as z from 'zod'
import {
  bindDeferredRpcOperation,
  defineRpcOperation
} from '../../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import type { StructuredAgentSessionHostSupport } from '../../agent-session/mobile-structured-agent-session-host-support'

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

/** Bound to the chat when a send is held; support is read when its deadline fires, since a
 *  relaunch claims saved sends before the capability probe answers. Null: the host can't be asked. */
export function useMobileStructuredSendRecorded(
  client: RpcClient | null,
  sessionId: string | null,
  hostSupport: StructuredAgentSessionHostSupport | null | undefined
): ((clientMessageId: string) => Promise<boolean> | null) | null {
  const supportedRef = useRef(false)
  useLayoutEffect(() => {
    supportedRef.current = hostSupport?.sendRecorded === true
  }, [hostSupport?.sendRecorded])
  return useMemo(
    () =>
      client && sessionId
        ? (clientMessageId: string) =>
            supportedRef.current
              ? readMobileStructuredSendRecorded(client, sessionId, clientMessageId)
              : null
        : null,
    [client, sessionId]
  )
}
