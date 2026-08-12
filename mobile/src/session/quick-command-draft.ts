import type {
  TerminalQuickCommand,
  TerminalQuickCommandAction,
  TerminalQuickCommandScope,
  TuiAgent
} from '../../../src/shared/types'
import {
  isAgentQuickCommand,
  MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH,
  MAX_QUICK_COMMAND_LABEL_LENGTH,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH,
  supportsTerminalAgentQuickCommand
} from '../terminal/quick-commands'

// A single mutable draft covering both quick-command actions. Both the command
// text and the agent/prompt are kept while editing so toggling Action back and
// forth doesn't discard what the user already typed (mirrors desktop's draft).
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

export function isQuickCommandDraftValid(draft: QuickCommandDraft): boolean {
  if (!draft.label.trim()) {
    return false
  }
  if (draft.action === 'agent-prompt') {
    return Boolean(
      draft.agent &&
      supportsTerminalAgentQuickCommand(draft.agent) &&
      draft.prompt.trim().length > 0
    )
  }
  return draft.command.trim().length > 0
}

// Build the persisted command from a draft. Returns null when incomplete so the
// caller can keep the editor open. The server re-normalizes, but we trim/cap
// here so optimistic local state matches what will be saved.
export function draftToQuickCommand(draft: QuickCommandDraft): TerminalQuickCommand | null {
  if (!isQuickCommandDraftValid(draft)) {
    return null
  }
  // Why: timestamps alone collide when desktop and mobile add commands in the
  // same millisecond, which would turn an atomic upsert into an overwrite.
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
      prompt: draft.prompt.trimEnd().slice(0, MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH),
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
