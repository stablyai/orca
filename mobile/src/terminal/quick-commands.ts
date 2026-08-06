import type { TerminalQuickCommand, TuiAgent } from '../../../src/shared/types'
import {
  applyTerminalQuickCommandMutation,
  flattenTerminalQuickCommand,
  isTerminalAgentQuickCommand,
  MAX_QUICK_COMMANDS,
  MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH,
  MAX_QUICK_COMMAND_LABEL_LENGTH,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH,
  parseNormalizedTerminalQuickCommands,
  supportsTerminalAgentQuickCommand,
  terminalQuickCommandMatchesRepo,
  type TerminalQuickCommandMutation
} from '../../../src/shared/terminal-quick-commands'
import { TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { MOBILE_TUI_AGENT_LABELS } from '../tasks/mobile-tui-agents'

// Reuse the canonical desktop quick-command logic (pure, no heavy deps) so
// mobile behaves identically to desktop. Only genuinely mobile-specific pieces
// — agent-branded labels, native row truncation, and the launch plan — live here.
export {
  isTerminalAgentQuickCommand as isAgentQuickCommand,
  terminalQuickCommandMatchesRepo as quickCommandMatchesRepo,
  supportsTerminalAgentQuickCommand,
  MAX_QUICK_COMMANDS,
  MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH,
  MAX_QUICK_COMMAND_LABEL_LENGTH,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH,
  parseNormalizedTerminalQuickCommands,
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
        // Why: raw commands that resemble bare agent launches can otherwise
        // select the fast path and race slow native, WSL, or SSH shell startup.
        // flattenTerminalQuickCommand joins multiline bodies exactly as desktop
        // does so the same saved command runs identically on both.
        options: {
          startupCommand: flattenTerminalQuickCommand(command).command,
          startupCommandDelivery: 'shell-ready'
        }
      }
}

export function getQuickCommandAgentLabel(agent: TuiAgent): string {
  return MOBILE_TUI_AGENT_LABELS[agent] ?? agent
}

// The subtitle desktop shows under each quick command: agent prompts read
// "Codex: <prompt>", terminal commands show the raw command text.
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
  // Why: one-line rows should not send up to 6 KB each through native text
  // layout; full command bodies remain available to search, edit, and launch.
  return `${preview.slice(0, MAX_QUICK_COMMAND_DISPLAY_PREVIEW_LENGTH - 1)}…`
}
