import { registerTerminalPtyExitWaiterTests } from './terminal-pty-exit-waiter.spec'
import { registerClaudeAgentTeamsPtyExitLeakTests } from './claude-agent-teams-pty-exit-leak.spec'
import { registerPtyExitAgentStatusReconciliationTests } from './pty-exit-agent-status-reconciliation.spec'
import { registerPtyTranscriptPruneWaitCacheTests } from './pty-transcript-prune-wait-cache.spec'

registerTerminalPtyExitWaiterTests()
registerClaudeAgentTeamsPtyExitLeakTests()
registerPtyExitAgentStatusReconciliationTests()
registerPtyTranscriptPruneWaitCacheTests()
