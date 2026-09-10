/**
 * `agent.launch` — the one method that starts an agent, whatever surface it turns out to be.
 *
 * It exists because the routing decision had no host-side home: `worktree.create` never consulted
 * it, so any client that created a worktree with `startupAgent` got a PTY agent no matter what the
 * user's default said. That is not fixable inside `worktree.create`, because its contract is
 * exactly "spawn a PTY agent and hand me its `agentTerminalHandle`" — a host that quietly answered
 * it with a structured session would hand every older client a response with no handle and no
 * error. So `worktree.create` keeps that meaning verbatim, forever, and everything that has to
 * choose a surface comes here instead, behind a negotiated capability.
 *
 * A caller therefore never asks for a mode, and must read `outcome.kind` rather than assume one:
 * the receipt always says which surface ran and why, so a downgrade is never silent.
 */

import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { AgentLaunchIntent, AgentLaunchTarget } from '../../../../shared/agent-launch-intent'
import { executeAgentLaunch } from '../../../agent-launch/agent-launch-executor'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { AgentLaunch, type AgentLaunchParams } from './agent-launch-schemas'
import { agentLaunchSurfaceFactory } from './agent-launch-surfaces'
import { agentLaunchWorkspaceFactory } from './agent-launch-worktree-creation'

/**
 * Advertising `agent.launch.v1` is a client's statement that it understands EITHER outcome — a
 * structured session it can open, or a terminal agent. A client that can only render one of the
 * two must keep using the surface-specific methods instead. In-process callers are the same build
 * as the host and negotiate nothing.
 */
export function supportsAgentLaunch(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(AGENT_LAUNCH_RUNTIME_CAPABILITY) === true
  )
}

/**
 * A client addresses a workspace by selector, but the result's `worktreeId` is an id and every
 * step below the executor re-prefixes it as `id:<worktreeId>`. Resolving here is what keeps a
 * caller's `id:wt-7` from reaching the runtime as `id:id:wt-7`; the terminal-workspace resolver is
 * used rather than the git-worktree one so a folder workspace is addressable too.
 */
async function agentLaunchTarget(
  params: AgentLaunchParams,
  runtime: Pick<OrcaRuntimeService, 'showManagedTerminalWorkspace'>
): Promise<AgentLaunchTarget> {
  if (params.target.kind === 'create-worktree') {
    return { kind: 'create-worktree', create: { ...params.target.create } }
  }
  const workspace = await runtime.showManagedTerminalWorkspace(params.target.worktree)
  return { kind: 'existing', worktree: workspace.id }
}

async function agentLaunchIntent(
  params: AgentLaunchParams,
  runtime: OrcaRuntimeService
): Promise<AgentLaunchIntent> {
  return {
    agent: params.agent,
    target: await agentLaunchTarget(params, runtime),
    ...(params.prompt ? { prompt: params.prompt } : {}),
    ...(params.sessionOptions ? { sessionOptions: params.sessionOptions } : {}),
    ...(params.reuseTerminal ? { reuseTerminal: params.reuseTerminal } : {})
  }
}

export const AGENT_LAUNCH_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'agent.launch',
    params: AgentLaunch,
    handler: async (params, context) => {
      if (!supportsAgentLaunch(context)) {
        throw new Error('agent_launch_unsupported')
      }
      const intent = await agentLaunchIntent(params, context.runtime)
      return executeAgentLaunch({
        runtime: context.runtime,
        intent,
        surfaces: agentLaunchSurfaceFactory(context),
        workspaces: agentLaunchWorkspaceFactory(context, intent.agent)
      })
    }
  })
]
