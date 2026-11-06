import { registerTerminalPtyExitWaiterTests } from '../launch/terminal-pty-exit-waiter.spec'
import { registerClaudeAgentTeamsPtyExitLeakTests } from '../../orca-runtime-tests/claude-agent-teams-pty-exit-leak.spec'

registerTerminalPtyExitWaiterTests()
registerClaudeAgentTeamsPtyExitLeakTests()
