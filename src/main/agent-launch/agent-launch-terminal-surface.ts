import { argvLaunchPrompt } from './agent-launch-prompt-delivery'
import {
  acceptedHeldMessagePlan,
  acceptedTerminalIntent,
  assertAcceptedTerminalAlternative
} from './agent-launch-acceptance'
import { terminalLaunchInputs } from './agent-launch-surface-factories'
import type { AgentLaunchSurfaceExecution } from './agent-launch-execution'
import type { CreatedSurface } from './agent-launch-executor'
import type { AgentLaunchTerminalStartupParams } from '../../shared/rpc-contract/agent-launch-accept-params'

/** The terminal agent a launch starts, chosen or as the alternative to a refused chat. An accepted
 *  launch starts only the terminal its caller planned, and its plan says where the held message goes. */
export async function createTerminalSurface(
  execution: AgentLaunchSurfaceExecution,
  workspace: { worktreeId: string; connectionId?: string | null }
): Promise<CreatedSurface> {
  const { surfaces, acceptance } = execution
  assertAcceptedTerminalAlternative(acceptance, execution.intent.agent)
  const plan = acceptance?.terminalStartup
  const held = acceptedHeldMessagePlan(plan)
  const intent = acceptedTerminalIntent(execution.intent, acceptance)
  // Only the host's own launcher is offered the text: a caller's command carries what its planner put there.
  const startupPrompt =
    plan?.kind === 'command' || held === 'none' ? undefined : argvLaunchPrompt(intent)
  // The plan's own draft is pasted once here, never as the held message, so it earns no receipt.
  const draft =
    (plan?.kind === 'command' ? plan.draftPrompt : undefined) ??
    (held === 'draft' ? intent.prompt?.text : undefined)
  const terminal = await surfaces.createTerminalAgent({
    worktreeId: workspace.worktreeId,
    agent: intent.agent,
    ...(startupPrompt ? { startupPrompt } : {}),
    ...terminalLaunchInputs(intent),
    ...(plan?.kind === 'command' ? { startup: callerCommand(plan) } : {}),
    ...(draft ? { draft } : {}),
    ...(acceptance ? { closed: acceptance.closed } : {}),
    viewMode: 'terminal'
  })
  // The caller's command already holds the message: that handoff is the delivery, never repeated.
  const carried = held === 'carried' || Boolean(startupPrompt && terminal.promptRodeLaunchCommand)
  return {
    outcome: {
      kind: 'terminal',
      handle: terminal.handle,
      ...(terminal.paneKey ? { paneKey: terminal.paneKey } : {})
    },
    terminalCreation: terminal.terminalCreation,
    ...(terminal.warning ? { warning: terminal.warning } : {}),
    ...(carried ? { promptRodeLaunchCommand: true } : {}),
    ...(held === 'none' ? { promptLeftUnsent: true } : {})
  }
}

/** What runs; where its input goes (held message, planned draft) is delivered here, not by the spawn. */
function callerCommand({
  kind: _kind,
  prompt: _prompt,
  draftPrompt: _draftPrompt,
  ...command
}: Extract<AgentLaunchTerminalStartupParams, { kind: 'command' }>) {
  return command
}
