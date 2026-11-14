import type { TerminalQuickCommand } from '../../../../src/shared/terminal/quick-commands/terminal-quick-command-types'
import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import {
  flattenTerminalQuickCommand,
  isTerminalAgentQuickCommand,
  supportsTerminalAgentQuickCommand
} from '../../../../src/shared/terminal/quick-commands/terminal-quick-commands'
import '../../../../src/shared/terminal/quick-commands/terminal-quick-command-prompt-limit'
import '../../../../src/shared/protocol-version'
import { TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY } from '../../../../src/shared/terminal/quick-commands/terminal-quick-command-capabilities'
import { TUI_AGENT_DISPLAY_NAMES as MOBILE_TUI_AGENT_LABELS } from '../../../../src/shared/agent-launch/catalog/tui-agent-display-names'

// Reuse the pure desktop command logic; renderer-only labels and native truncation stay here.

const MAX_QUICK_COMMAND_DISPLAY_PREVIEW_LENGTH = 240

export function supportsMobileQuickCommands(capabilities: readonly string[] | undefined): boolean {
  return capabilities?.includes(TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY) === true
}

export type MobileQuickCommandLaunch = {
  agent?: TuiAgent
  options: {
    agentPrompt?: string
    startupCommand?: string
    startupCommandDelivery?: 'shell-ready'
    initialPrompt?: string
    enter?: boolean
    successToast?: string
  }
}

export function buildMobileQuickCommandLaunch(
  command: TerminalQuickCommand
): MobileQuickCommandLaunch | null {
  if (isTerminalAgentQuickCommand(command)) {
    if (!command.prompt.trim() || !supportsTerminalAgentQuickCommand(command.agent)) {
      return null
    }
    return { agent: command.agent, options: { agentPrompt: command.prompt } }
  }
  if (!command.command.trim()) {
    return null
  }
  return command.appendEnter === false
    ? {
        options: {
          initialPrompt: command.command,
          enter: false,
          successToast: `${command.label.trim() || 'Quick command'} inserted`
        }
      }
    : {
        // Raw agent-looking commands must not bypass slow native/WSL/SSH startup; flatten multiline commands identically to desktop.
        options: {
          startupCommand: flattenTerminalQuickCommand(command).command,
          startupCommandDelivery: 'shell-ready'
        }
      }
}

export function getQuickCommandAgentLabel(agent: TuiAgent): string {
  return MOBILE_TUI_AGENT_LABELS[agent] ?? agent
}

export function getQuickCommandPreview(command: TerminalQuickCommand): string {
  if (isTerminalAgentQuickCommand(command)) {
    return `${getQuickCommandAgentLabel(command.agent)}: ${command.prompt}`
  }
  return command.command
}

export function getQuickCommandDisplayPreview(command: TerminalQuickCommand): string {
  const preview = getQuickCommandPreview(command)
  if (preview.length <= MAX_QUICK_COMMAND_DISPLAY_PREVIEW_LENGTH) {
    return preview
  }
  // Bound native row layout for long prompts while preserving full bodies for search, editing and launch.
  return `${preview.slice(0, MAX_QUICK_COMMAND_DISPLAY_PREVIEW_LENGTH - 1)}…`
}
