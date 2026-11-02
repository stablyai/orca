import { rebaseCompletedContextRewind } from '../../native-chat/agent-session-journal/context-transfer-rebase'
import type { AgentSessionStoreTransactions } from './records/agent-session-store-transactions'
import {
  commitConversationClearRecord,
  type AgentSessionConversationClear
} from './records/agent-session-conversation-command-record'
import { settleAgentSessionOperationInto } from './ownership/agent-session-operation-admission'
import { commitAgentSessionRewindCompletion } from './agent-session-rewind-completion'

export function createAgentSessionConversationReceipts(
  transactions: Pick<AgentSessionStoreTransactions, 'receipt'>
) {
  return {
    clear: (
      clear: () => AgentSessionConversationClear,
      operation: { callerKey: string; operationId: string }
    ) =>
      transactions.receipt((draft) => {
        const completed = clear()
        commitConversationClearRecord(draft, completed)
        settleAgentSessionOperationInto(draft, {
          ...operation,
          outcome: {
            status: 'succeeded',
            sessionId: completed.sessionId,
            conversationCommand: completed.command
          }
        })
      }),
    rewind: (
      ...args: Parameters<typeof commitAgentSessionRewindCompletion> extends [unknown, ...infer A]
        ? A
        : never
    ) => {
      const receipt = transactions.receipt((draft) =>
        commitAgentSessionRewindCompletion(draft, ...args)
      )
      return {
        ...receipt,
        write: (db, row) => {
          receipt.write(db, row)
          rebaseCompletedContextRewind(db, args[0])
        }
      }
    }
  }
}
