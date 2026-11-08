import type { AgentSessionForkedFrom } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionStoreTransactions } from './records/agent-session-store-transactions'
import type { AgentSessionConversationClear } from './records/agent-session-conversation-command-record'
import type { commitAgentSessionRewindCompletion } from './agent-session-rewind-completion'

export function createAgentSessionConversationReceipts(
  transactions: Pick<AgentSessionStoreTransactions, 'mutationReceipt'>
) {
  return {
    forkBoundary: (sessionId: string, forkedFrom: AgentSessionForkedFrom) =>
      transactions.mutationReceipt({ kind: 'fork-boundary', sessionId, forkedFrom }),
    clear: (
      clear: () => AgentSessionConversationClear,
      operation: { callerKey: string; operationId: string }
    ) => transactions.mutationReceipt(() => ({ kind: 'clear', clear: clear(), operation })),
    rewind: (
      ...args: Parameters<typeof commitAgentSessionRewindCompletion> extends [unknown, ...infer A]
        ? A
        : never
    ) =>
      transactions.mutationReceipt({
        kind: 'rewind-complete',
        sessionId: args[0],
        fence: args[1],
        rewind: args[2],
        childBoundary: args[5]
      })
  }
}
