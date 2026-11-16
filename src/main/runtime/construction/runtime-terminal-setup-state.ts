import { RuntimeAgentStatusSources } from './runtime-agent-status-sources'
import { SetupTerminalCompletions } from '../terminal/wait/setup-terminal-completions'

export abstract class RuntimeTerminalSetupState extends RuntimeAgentStatusSources {
  protected readonly setupTerminalCompletions = new SetupTerminalCompletions((ptyId, verdict) => {
    const status = { ...verdict, ptyId, runtimeId: this.runtimeId }
    this.notifier?.terminalSetupChanged?.(status)
    this.emitClientEvent({ type: 'terminalSetupChanged', status })
  })
}
