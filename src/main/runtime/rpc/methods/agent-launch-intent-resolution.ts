/** Resolve selectors and validate terminal reuse without creating a surface. */

import type { AgentLaunchIntent, AgentLaunchTarget } from '../../../../shared/agent-launch-intent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { assertOpenCodeModelLaunchPreferencesAbsent } from '../../../opencode/opencode-model-startup-plan'
import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'
import type { EarlyAgentLaunchTab } from './agent-launch-tab-publication'

/** Resolve the selector once to avoid id:id: prefixes below the executor.
 * Use launch scope: floating workspaces have no Git worktree record, and folder rows are synthetic. */
async function agentLaunchTarget(
  params: AgentLaunchParams,
  runtime: Pick<OrcaRuntimeService, 'showTerminalWorkspaceLaunchScope'>
): Promise<AgentLaunchTarget> {
  if (params.target.kind !== 'existing') {
    return { kind: params.target.kind, create: { ...params.target.create } }
  }
  const workspace = await runtime.showTerminalWorkspaceLaunchScope(params.target.worktree)
  return {
    kind: 'existing',
    worktree: workspace.id,
    workspacePath: workspace.path,
    connectionId: workspace.connectionId
  }
}

async function agentLaunchIntent(
  params: AgentLaunchParams,
  runtime: OrcaRuntimeService,
  /** The pane of a tab already shown for this launch; the spawn must land in it. */
  publishedPaneKey: string | undefined
): Promise<AgentLaunchIntent> {
  const paneKey = publishedPaneKey ?? params.paneKey
  return {
    agent: params.agent,
    target: await agentLaunchTarget(params, runtime),
    ...(params.prompt ? { prompt: params.prompt } : {}),
    ...(params.sessionOptions ? { sessionOptions: params.sessionOptions } : {}),
    ...(params.reuseTerminal ? { reuseTerminal: params.reuseTerminal } : {}),
    // `null` means "no arguments" and must survive; only absence falls back to the settings default.
    ...(params.agentArgs !== undefined ? { agentArgs: params.agentArgs } : {}),
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(params.launchSource ? { launchSource: params.launchSource } : {}),
    ...(paneKey ? { paneKey } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.accountEnv ? { accountEnv: params.accountEnv } : {}),
    ...(params.nativeChatDefault !== undefined
      ? { nativeChatDefault: params.nativeChatDefault }
      : {}),
    ...(params.surface ? { surface: params.surface } : {})
  }
}

async function validateReusedTerminal(
  intent: AgentLaunchIntent,
  runtime: Pick<OrcaRuntimeService, 'showTerminal' | 'isTerminalRunningAgent'>
): Promise<void> {
  if (!intent.reuseTerminal) {
    return
  }
  if (intent.target.kind !== 'existing') {
    throw new Error('agent_launch_reuse_requires_existing_workspace')
  }
  const terminal = await runtime.showTerminal(intent.reuseTerminal.handle)
  if (terminal.worktreeId !== intent.target.worktree) {
    throw new Error('agent_launch_terminal_worktree_mismatch')
  }
  if (!(await runtime.isTerminalRunningAgent(intent.reuseTerminal.handle))) {
    throw new Error('agent_launch_terminal_not_running_agent')
  }
}

/** Resolve and validate before creation so a throw proves failed rather than unknown in the ledger. */
export async function resolveUnlaunchedIntent(
  params: AgentLaunchParams,
  runtime: OrcaRuntimeService,
  early: EarlyAgentLaunchTab | null
): Promise<AgentLaunchIntent> {
  if (params.reuseTerminal || params.target.kind === 'create-worktree') {
    assertOpenCodeModelLaunchPreferencesAbsent(params.agent, params.sessionOptions)
  }
  const intent = await agentLaunchIntent(params, runtime, early?.paneKey)
  await validateReusedTerminal(intent, runtime)
  return intent
}
