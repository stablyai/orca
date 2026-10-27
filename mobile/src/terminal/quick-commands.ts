import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import {
  applyTerminalQuickCommandMutation,
  flattenTerminalQuickCommand,
  getTerminalQuickCommandBody,
  isTerminalAgentQuickCommand,
  MAX_QUICK_COMMAND_LABEL_LENGTH,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH,
  parseNormalizedTerminalQuickCommands,
  supportsTerminalAgentQuickCommand,
  terminalQuickCommandMatchesRepo,
  type TerminalQuickCommandMutation
} from '../../../src/shared/terminal-quick-commands'
import {
  getTerminalQuickCommandBodySize,
  formatKilobytes,
  terminalQuickCommandAgentPromptMaxLength
} from '../../../src/shared/terminal-quick-command-prompt-limit'
import { TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { MOBILE_TUI_AGENT_LABELS } from '../tasks/mobile-tui-agents'

// Reuse the pure desktop command logic; renderer-only labels and native truncation stay here.
export {
  isTerminalAgentQuickCommand as isAgentQuickCommand,
  getTerminalQuickCommandBody,
  terminalQuickCommandMatchesRepo as quickCommandMatchesRepo,
  supportsTerminalAgentQuickCommand,
  getTerminalQuickCommandBodySize,
  formatKilobytes,
  MAX_QUICK_COMMAND_LABEL_LENGTH,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH,
  parseNormalizedTerminalQuickCommands,
  terminalQuickCommandAgentPromptMaxLength,
  applyTerminalQuickCommandMutation,
  type TerminalQuickCommandMutation
}

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
