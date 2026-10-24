import type { HostFoundingAttempt } from '../../agent-launch/host-founding-attempt'

import type { JournalTransactionObservation } from '../agent-session-journal/journal-database'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'

import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'

import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { reserveRequestFor, AgentSessionAttachParams } from './structured-agent-session-attach'

import { performSend, type AgentSessionOperationReceipt } from './structured-agent-session-turns'

import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'

import type { StructuredAgentSessionCreateOptions } from './structured-agent-session-create'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

export function createFoundingReceipt(
  context: StructuredAgentSessionAttachContext,
  request: ReturnType<typeof reserveRequestFor>,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionCreateOptions,
  attempt: HostFoundingAttempt | undefined
): (opening: boolean) => JournalOperationReceipt {
  const { store } = context.deps
  const sessionId = params.envelope.sessionId
  return (opening: boolean): JournalOperationReceipt => {
    const receipt = store.founding.receipt(request)
    if (!attempt) {
      return receipt
    }
    const transaction: JournalTransactionObservation = { disposition: 'not-attempted' }
    if (opening) {
      attempt.opening = { transaction }
    } else {
      attempt.blank = transaction
    }
    return {
      transactionObservation: transaction,
      write: (db, row) => {
        attempt.beforeWrite?.()
        receipt.write(db, row)
        const openingMessage = options.firstMessage
        if (
          opening &&
          openingMessage &&
          row?.kind === 'submission' &&
          row.clientMessageId === openingMessage.clientMessageId &&
          row.payloadFingerprint ===
            computeAgentSessionPayloadFingerprint({
              method: 'agentSession.send',
              sessionId,
              fields: { body: openingMessage.body }
            }) &&
          attempt.opening
        ) {
          attempt.opening.row = row
        }
      },
      committed: () => {
        receipt.committed()
        const record = store.getRecord(sessionId)
        if (!record || record.provider !== params.agent) {
          throw new Error('committed_founding_record_not_adopted')
        }
        const tabId = store.getSessionTabId(sessionId)
        attempt.adopted = {
          sessionId: record.sessionId,
          workspaceId: record.location.workspaceId,
          agent: params.agent,
          fence: record.lease.runtimeFence,
          ...(tabId ? { tabId } : {})
        }
      }
    }
  }
}

export function sendOpeningFoundingMessage(
  context: StructuredAgentSessionAttachContext,
  params: AgentSessionAttachParams,
  session: StructuredAgentSessionHostSession,
  record: AgentSessionRecord,
  callerKey: string,
  fence: number,
  first: NonNullable<StructuredAgentSessionCreateOptions['firstMessage']>,
  receipt: AgentSessionOperationReceipt
) {
  const { deps } = context
  const sessionId = params.envelope.sessionId
  return performSend(
    {
      sessionId,
      journal: session.journal,
      fence,
      adapter: deps.adapter,
      agents: deps.agents,
      agent: params.agent,
      logger: deps.logger,
      resolvedBy: callerKey,
      persistedOptions: record.options,
      persistOptions: async () => {},
      publish: () => {},
      operationReceipt: receipt,
      now: context.now
    },
    {
      ...first,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId,
        fields: { body: first.body }
      }),
      origin: 'client',
      source: { kind: 'user' },
      ...openingMessageOptions(record.options)
    }
  )
}

/** The model and effort the chat was created with, which its opening message runs on as a send's
 *  carried ones do. */
function openingMessageOptions(options: Readonly<Record<string, string>> | undefined): {
  options?: AgentSessionExecutionOptions
} {
  const { model, effort } = options ?? {}
  return model ? { options: { model, ...(effort ? { effort } : {}) } } : {}
}
