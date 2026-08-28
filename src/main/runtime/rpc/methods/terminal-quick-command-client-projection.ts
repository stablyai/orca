import { TERMINAL_QUICK_COMMAND_AGENT_DRAFTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeCapability } from '../../../../shared/protocol-version'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { isTerminalAgentQuickCommand } from '../../../../shared/terminal-quick-commands'

export function projectTerminalQuickCommandsForClient(
  commands: readonly TerminalQuickCommand[],
  clientCapabilities: readonly RuntimeCapability[] | undefined
): TerminalQuickCommand[] {
  if (
    clientCapabilities === undefined ||
    clientCapabilities.includes(TERMINAL_QUICK_COMMAND_AGENT_DRAFTS_RUNTIME_CAPABILITY)
  ) {
    return [...commands]
  }
  return commands.map((command) => {
    if (!isTerminalAgentQuickCommand(command)) {
      return command
    }
    const { submitPrompt: _submitPrompt, ...legacyCommand } = command
    void _submitPrompt
    return legacyCommand
  })
}
