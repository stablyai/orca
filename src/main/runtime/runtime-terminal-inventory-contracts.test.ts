import { registerTerminalListExecutionHostScopeTests } from './terminal-list-execution-host-scope.spec'
import { registerPtyInventoryLivenessVerdictTests } from './pty-inventory-liveness-verdict.spec'
import { registerPtyInventoryPartialRelayLivenessTests } from './pty-inventory-partial-relay-liveness.spec'
import { registerSessionTabsEmptyWorktreePublicationTests } from './session-tabs-empty-worktree-publication.spec'

registerTerminalListExecutionHostScopeTests()
registerPtyInventoryLivenessVerdictTests()
registerPtyInventoryPartialRelayLivenessTests()
registerSessionTabsEmptyWorktreePublicationTests()
