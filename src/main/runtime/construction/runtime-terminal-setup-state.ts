import { RuntimeAgentStatusSources } from './runtime-agent-status-sources'
import { SetupTerminalCompletions } from '../terminal/wait/setup-terminal-completions'
import { publishSetupFailureMarker } from '../../workspace-hooks/setup-failure-marker'

export abstract class RuntimeTerminalSetupState extends RuntimeAgentStatusSources {
  protected readonly setupTerminalCompletions = new SetupTerminalCompletions((ptyId, verdict) => {
    const status = { ...verdict, ptyId, runtimeId: this.runtimeId }
    this.notifier?.terminalSetupChanged?.(status)
    this.emitClientEvent({ type: 'terminalSetupChanged', status })
  }, publishSetupFailureMarker)
}
