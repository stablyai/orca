import type {
  TerminalQuickCommand,
  TerminalQuickCommandAction,
  TerminalQuickCommandScope
} from '../../../src/shared/terminal-quick-command-types'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import {
  getTerminalQuickCommandBodySize,
  isAgentQuickCommand,
  MAX_QUICK_COMMAND_LABEL_LENGTH,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH,
  supportsTerminalAgentQuickCommand
} from '../terminal/quick-commands'

// Retain command and agent/prompt edits across Action switches so toggling cannot discard typing.
export type QuickCommandDraft = {
  id: string | null
  label: string
  action: TerminalQuickCommandAction
  command: string
  appendEnter: boolean
  agent: TuiAgent | null
  prompt: string
  scope: TerminalQuickCommandScope
}

export function createEmptyQuickCommandDraft(scope: TerminalQuickCommandScope): QuickCommandDraft {
  return {
    id: null,
    label: '',
    action: 'terminal-command',
    command: '',
    appendEnter: true,
    agent: null,
    prompt: '',
    scope
  }
}

export function quickCommandToDraft(command: TerminalQuickCommand): QuickCommandDraft {
  const scope: TerminalQuickCommandScope =
    command.scope?.type === 'repo' && command.scope.repoId
      ? { type: 'repo', repoId: command.scope.repoId }
      : { type: 'global' }
  if (isAgentQuickCommand(command)) {
    return {
      id: command.id,
      label: command.label,
      action: 'agent-prompt',
      command: '',
      appendEnter: true,
      agent: command.agent,
      prompt: command.prompt,
      scope
    }
  }
  return {
    id: command.id,
    label: command.label,
    action: 'terminal-command',
    command: command.command,
    appendEnter: command.appendEnter !== false,
    agent: null,
    prompt: '',
    scope
  }
}

/** Whether the draft's prompt is over its limit; `agentPromptMaxLength` is an older host's cap. */
export function isQuickCommandDraftPromptTooLong(
  draft: QuickCommandDraft,
  agentPromptMaxLength: number | null
): boolean {
  if (draft.action !== 'agent-prompt') {
    return false
  }
  const size = getTerminalQuickCommandBodySize('agent-prompt', draft.prompt, agentPromptMaxLength)
  return size.used > size.max
}

export function isQuickCommandDraftValid(
  draft: QuickCommandDraft,
  agentPromptMaxLength: number | null = null
): boolean {
  if (!draft.label.trim()) {
    return false
  }
  if (draft.action === 'agent-prompt') {
    return Boolean(
      draft.agent &&
      supportsTerminalAgentQuickCommand(draft.agent) &&
      draft.prompt.trim().length > 0 &&
      !isQuickCommandDraftPromptTooLong(draft, agentPromptMaxLength)
    )
  }
  return draft.command.trim().length > 0
}

// Normalize before saving so optimistic commands match host-canonical values.
export function draftToQuickCommand(
  draft: QuickCommandDraft,
  agentPromptMaxLength: number | null = null
): TerminalQuickCommand | null {
  if (!isQuickCommandDraftValid(draft, agentPromptMaxLength)) {
    return null
  }
  // Timestamps can collide across desktop/mobile; add randomness so atomic upserts cannot overwrite another command.
  const id =
    draft.id ??
    `quick-command-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const label = draft.label.trim().slice(0, MAX_QUICK_COMMAND_LABEL_LENGTH)
  if (draft.action === 'agent-prompt' && draft.agent) {
    return {
      id,
      label,
      action: 'agent-prompt',
      agent: draft.agent,
      prompt: draft.prompt.trimEnd(),
      scope: draft.scope
    }
  }
  return {
    id,
    label,
    action: 'terminal-command',
    command: draft.command.trimEnd().slice(0, MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH),
    appendEnter: draft.appendEnter,
    scope: draft.scope
  }
}
