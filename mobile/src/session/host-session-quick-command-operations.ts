import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import type { TerminalQuickCommandMutation } from '../terminal/quick-commands'

export type HostSessionQuickCommandSnapshot = {
  commands: TerminalQuickCommand[]
}

export type HostSessionQuickCommandOperations = {
  snapshot(signal?: AbortSignal): Promise<HostSessionQuickCommandSnapshot>
  mutate(mutation: TerminalQuickCommandMutation): Promise<HostSessionQuickCommandSnapshot>
}
