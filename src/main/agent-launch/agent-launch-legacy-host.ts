/** Legacy creation owns both the startup terminal and prompt delivery. */

import type {
  AgentLaunchPrompt,
  AgentLaunchPromptDisposal,
  AgentLaunchResult
} from '../../shared/agent-launch-intent'
import { agentPromptRidesLaunchCommand } from '../../shared/tui-agent-startup'
import type { AgentLaunchExecution, AgentLaunchLegacyHostExecution } from './agent-launch-execution'
import type { AgentLaunchModeReceipt } from './agent-launch-mode'
import {
  HANDED_TO_TERMINAL,
  launchCommandPrompt,
  promptReceipt
} from './agent-launch-prompt-delivery'

/** No returned agent may mean deferred activation; creating another risks a duplicate. */
export class AgentLaunchStartupAgentNotCreatedError extends Error {
  readonly worktreeId: string

  constructor(worktreeId: string) {
    super('agent_launch_startup_agent_not_created')
    this.name = 'AgentLaunchStartupAgentNotCreatedError'
    this.worktreeId = worktreeId
  }
}

export function createLaunchPromptInputs(
  execution: AgentLaunchExecution,
  mode: AgentLaunchModeReceipt['mode']
): { startupPrompt?: string; legacyPrompt?: AgentLaunchPrompt } {
  if (execution.promptPolicy !== 'legacy-host') {
    const startupPrompt = launchCommandPrompt(execution.intent, mode)
    return startupPrompt ? { startupPrompt } : {}
  }
  return execution.intent.prompt ? { legacyPrompt: execution.intent.prompt } : {}
}

export function assertLegacyHostTarget(execution: AgentLaunchLegacyHostExecution): void {
  if (execution.intent.target.kind !== 'create-worktree') {
    throw new Error('agent_launch_legacy_prompt_policy_requires_terminal_create')
  }
}

export function legacyHostCreateResult(
  execution: AgentLaunchLegacyHostExecution,
  placed: {
    worktreeId: string
    startupTerminalHandle: string | undefined
    startupTerminalPaneKey?: string
    warning?: string
  },
  receipt: AgentLaunchModeReceipt
): AgentLaunchResult {
  if (!placed.startupTerminalHandle) {
    throw new AgentLaunchStartupAgentNotCreatedError(placed.worktreeId)
  }
  const { intent } = execution
  return {
    outcome: {
      kind: 'terminal',
      handle: placed.startupTerminalHandle,
      ...(placed.startupTerminalPaneKey ? { paneKey: placed.startupTerminalPaneKey } : {})
    },
    worktreeId: placed.worktreeId,
    receipt,
    ...(placed.warning ? { warning: placed.warning } : {}),
    ...promptReceipt(intent, legacyCreatePromptDisposal(intent))
  }
}

/** Post-start sends are unawaited, so report unconfirmed to prevent duplicate delivery. */
function legacyCreatePromptDisposal(
  intent: AgentLaunchLegacyHostExecution['intent']
): AgentLaunchPromptDisposal {
  if (intent.prompt?.delivery !== 'submit') {
    return { outcome: 'not-delivered' }
  }
  return agentPromptRidesLaunchCommand(intent.agent)
    ? HANDED_TO_TERMINAL
    : { outcome: 'unconfirmed' }
}
