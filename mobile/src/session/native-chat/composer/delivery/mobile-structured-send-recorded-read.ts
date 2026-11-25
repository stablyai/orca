import { useLayoutEffect, useMemo, useRef } from 'react'
import * as z from 'zod'
import {
  bindDeferredRpcOperation,
  defineRpcOperation
} from '../../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import type { StructuredAgentSessionHostSupport } from '../../agent-session/mobile-structured-agent-session-host-support'
import { AgentJournalSubmissionSchema } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-submission-schema'

const sendRecordSchema = z.object({
  recorded: z.boolean(),
  submission: AgentJournalSubmissionSchema.pick({
    clientMessageId: true,
    dispatchState: true,
    reason: true,
    rejection: true,
    queuedMessageId: true,
    keptAsQueuedMessageId: true
  })
    .extend({
      dispatchState: z.enum(['pending', 'accepted', 'rejected', 'unknown'])
    })
    .optional(),
  ownedByQueue: z.literal(true).optional()
})
export type MobileStructuredSendRecord = z.infer<typeof sendRecordSchema>
export type MobileStructuredSendConfirmation = (
  id: string
) => Promise<MobileStructuredSendRecord> | null

const sendRecordedRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agentSession.sendRecorded',
    method: 'agentSession.sendRecorded',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('structured-send-recorded', sendRecordSchema)
  })
)

const REQUEST_OPTIONS = { timeoutMs: 10_000, budgetSpansConnect: true }

/** Whether the host recorded a send its loaded pages don't show; any failure is "not proven". */
function readMobileStructuredSendRecorded(
  client: RpcClient,
  sessionId: string,
  clientMessageId: string
): Promise<MobileStructuredSendRecord> {
  return sendRecordedRead
    .request(client, { sessionId, clientMessageId }, REQUEST_OPTIONS)
    .then((reply) => sendRecordedRead.interpret(reply) ?? { recorded: false })
    .catch(() => ({ recorded: false }))
}

/** Bound to the chat when a send is held; support is read when its deadline fires, since a
 *  relaunch claims saved sends before the capability probe answers. Null: the host can't be asked. */
export function useMobileStructuredSendRecorded(
  client: RpcClient | null,
  sessionId: string | null,
  hostSupport: StructuredAgentSessionHostSupport | null | undefined
): ((clientMessageId: string) => Promise<MobileStructuredSendRecord> | null) | null {
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
