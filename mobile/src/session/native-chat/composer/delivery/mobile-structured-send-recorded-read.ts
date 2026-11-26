import { useMemo } from 'react'
import * as z from 'zod'
import {
  bindDeferredRpcOperation,
  defineRpcOperation
} from '../../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../../transport/rpc/rpc-operation-result-reader'
import type { UnvalidatedRpcRequestPort } from '../../../../transport/rpc/unvalidated-rpc-request-port'
import type { StructuredAgentSessionHostSupport } from '../../agent-session/mobile-structured-agent-session-host-support'
import { AgentJournalSubmissionSchema } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-submission-schema'
import { AGENT_JOURNAL_DISPATCH_STATES } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-dispatch'

const sendRecordSchema = z.object({
  recorded: z.boolean(),
  confirmedAbsent: z.literal(true).optional(),
  submission: AgentJournalSubmissionSchema.pick({
    clientMessageId: true,
    dispatchState: true,
    reason: true,
    rejection: true,
    queuedMessageId: true,
    keptAsQueuedMessageId: true
  })
    .extend({
      dispatchState: z.enum(AGENT_JOURNAL_DISPATCH_STATES)
    })
    .optional(),
  ownedByQueue: z.literal(true).optional()
})
export type MobileStructuredSendRecord = z.infer<typeof sendRecordSchema>
export type MobileStructuredSendConfirmation = (id: string) => Promise<MobileStructuredSendRecord>

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
const NOT_RECORDED = { recorded: false } as const

/** Whether the host recorded a send its loaded pages don't show; any failure is "not proven". */
function readMobileStructuredSendRecorded(
  client: UnvalidatedRpcRequestPort,
  sessionId: string,
  clientMessageId: string,
  supportsAbsence: boolean
): Promise<MobileStructuredSendRecord> {
  return sendRecordedRead
    .request(client, { sessionId, clientMessageId }, REQUEST_OPTIONS)
    .then((reply) => {
      const answer: MobileStructuredSendRecord = sendRecordedRead.interpret(reply) ?? NOT_RECORDED
      if (answer.confirmedAbsent && !supportsAbsence) {
        return { ...answer, confirmedAbsent: undefined }
      }
      return answer
    })
    .catch(() => NOT_RECORDED)
}

export function useMobileStructuredSendRecorded(
  client: UnvalidatedRpcRequestPort | null,
  sessionId: string | null,
  hostSupport: StructuredAgentSessionHostSupport | null | undefined
): MobileStructuredSendConfirmation | null {
  const support = hostSupport?.sendRecorded
  return useMemo(
    () =>
      client && sessionId && support
        ? (clientMessageId: string) =>
            readMobileStructuredSendRecorded(
              client,
              sessionId,
              clientMessageId,
              support === 'confirmed-absence'
            )
        : null,
    [client, sessionId, support]
  )
}
