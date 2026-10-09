/**
 * The executor's half of the `legacy-host` prompt policy: `worktree.create`'s own startup contract,
 * kept for the host's legacy producers until one planner replaces both policies.
 *
 * The create owns the text, so the executor hands it the whole prompt instead of an argv offer and
 * delivers nothing itself; and the create's startup terminal is the launch's only surface.
 */

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

/**
 * The create's startup terminal is a `legacy-host` launch's only surface: a create that could not
 * spawn it here handed it to the window's activation or reported why in its warning, so building
 * another would start the agent twice. The workspace exists; no agent came back.
 *
 * Caught only by `createWorktreeWithStartupAgent`, which answers with the create's own result as
 * `worktree.create` always has. That shared entry is the only `legacy-host` producer; headless
 * automations and federation, which still call `createManagedWorktree` directly, are to move onto
 * it rather than repeat this catch. Orchestration workers are not `legacy-host` and never see it.
 */
export class AgentLaunchStartupAgentNotCreatedError extends Error {
  readonly worktreeId: string

  constructor(worktreeId: string) {
    super('agent_launch_startup_agent_not_created')
    this.name = 'AgentLaunchStartupAgentNotCreatedError'
    this.worktreeId = worktreeId
  }
}

/** What a create is handed to deliver: the launch's argv offer, or under this policy all of it. */
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

/** Refuses a cast past the type before the workspace exists, so it cannot leave one behind. */
export function assertLegacyHostTarget(execution: AgentLaunchLegacyHostExecution): void {
  if (execution.intent.target.kind !== 'create-worktree') {
    throw new Error('agent_launch_legacy_prompt_policy_requires_terminal_create')
  }
}

/** The launch once the create returned; see `AgentLaunchStartupAgentNotCreatedError` for none. */
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

/**
 * By the delivery module's rule, each arm names an act that already happened. The create folds a
 * submit into the command that starts any agent taking it on argv (`buildAgentStartupPlan` leaves
 * no follow-up for those), so that text is handed over. A post-start agent gets it from a send the
 * create fires and does not await, so it is `unconfirmed` here: host-internal, never on the wire,
 * meaning "may have arrived, do not resend". A draft is unsent text the host never vouches for.
 */
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
