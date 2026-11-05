import { registerTerminalListExecutionHostScopeTests } from './terminal-list-execution-host-scope.spec'
import { registerPtyInventoryLivenessVerdictTests } from '../../orca-runtime-tests/pty-inventory-liveness-verdict.spec'
import { registerSessionTabsEmptyWorktreePublicationTests } from '../../orca-runtime-tests/session-tabs-empty-worktree-publication.spec'

registerTerminalListExecutionHostScopeTests()
registerPtyInventoryLivenessVerdictTests()
registerSessionTabsEmptyWorktreePublicationTests()
