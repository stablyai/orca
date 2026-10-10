/**
 * Turning `agent.launch` params into the intent the executor runs: the caller's workspace selector
 * resolved to an id, and a reused terminal checked. Nothing here creates anything.
 */

import type { AgentLaunchIntent, AgentLaunchTarget } from '../../../../shared/agent-launch-intent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { assertOpenCodeModelLaunchPreferencesAbsent } from '../../../opencode/opencode-model-startup-plan'
import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'
import type { EarlyAgentLaunchTab } from './agent-launch-tab-publication'

/**
 * A client addresses a workspace by selector, but the result's `worktreeId` is an id and every
 * step below the executor re-prefixes it as `id:<worktreeId>`. Resolving here is what keeps a
 * caller's `id:wt-7` from reaching the runtime as `id:id:wt-7`.
 *
 * The launch *scope* is what is asked for, because the id below is the only thing read off it. The
 * git-worktree record is the narrower answer — it does not exist for the floating workspace, so
 * asking for one refused a launch this method can perfectly well run, on a workspace whose id it
 * had already resolved. A folder workspace survived that only because the resolver fabricates a
 * worktree row for it; the scope is the answer that is real for all three kinds.
 */
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
    ...(params.sessionId ? { sessionId: params.sessionId } : {})
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

/**
 * The half before anything is created: resolve the caller's selector, then check a reused terminal.
 * A throw from here proves no surface was built, which is what lets the ledger record a launch that
 * failed in it as `failed` rather than `unknown`.
 */
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
