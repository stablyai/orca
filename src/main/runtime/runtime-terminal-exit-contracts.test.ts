import { registerTerminalPtyExitWaiterTests } from './terminal-pty-exit-waiter.spec'
import { registerClaudeAgentTeamsPtyExitLeakTests } from './claude-agent-teams-pty-exit-leak.spec'

registerTerminalPtyExitWaiterTests()
registerClaudeAgentTeamsPtyExitLeakTests()
