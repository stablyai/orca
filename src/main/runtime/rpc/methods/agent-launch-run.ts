import type { HostFoundingAttempt } from '../../../agent-launch/host-founding-attempt'

import type { AgentLaunchIntent, AgentLaunchResult } from '../../../../shared/agent-launch-intent'

import { executeAgentLaunch } from '../../../agent-launch/agent-launch-executor'
import type { TerminalSpawnDispatch } from '../../../agent-launch/agent-launch-not-started'

import type { RpcContext } from '../core'

import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'
import { agentLaunchSurfaceFactory } from './agent-launch-surfaces'

import {
  agentLaunchCallerNavigationId,
  selectAgentLaunchTabForCaller
} from './agent-launch-caller-selection'
import { agentLaunchWorkspaceCreation } from './agent-launch-worktree-creation'

import { clientRendersStructuredAgent } from './structured-agent-session-policy'
import { resolveUnlaunchedIntent } from './agent-launch-intent-resolution'
import { withPlacement, type AgentLaunchView } from './agent-launch-tab-publication'

/**
 * `agent.launch.v2` was defined when Claude and Codex were the only chats, so it vouches for those
 * two. Any other agent's chat needs the client to say it reads it, by the rule tabs and restart
 * offers use; a client that does not gets that agent as a terminal.
 */
function callerRendersLaunchedChat(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>,
  agent: string
): boolean {
  return (
    context.clientKind === undefined ||
    agent === 'claude' ||
    agent === 'codex' ||
    clientRendersStructuredAgent(context.clientCapabilities, agent)
  )
}

/** What a launch admitted under an operation id carries into its execution. */
type ReplaySafeLaunch = {
  attachOperationId: string
  callerKey: string
  terminalSpawn: TerminalSpawnDispatch
  /** Records the surface the moment it exists, an owed prompt as `unconfirmed`. Fired, never
   *  awaited: the ledger's transactions run in order, so the final settle still lands after it, and
   *  the prompt never waits on bookkeeping. */
  recordSurface: (provisional: AgentLaunchResult) => void
}

export async function runAgentLaunch(
  intent: AgentLaunchIntent,
  context: RpcContext,
  view: AgentLaunchView,
  replaySafe?: ReplaySafeLaunch,
  hostFoundingAttempt: HostFoundingAttempt = {}
): Promise<AgentLaunchResult> {
  const callerNavigationId = agentLaunchCallerNavigationId(intent.target, context)
  const result = await executeAgentLaunch({
    runtime: context.runtime,
    intent,
    hostFoundingAttempt,
    onSurfaceAdmitted: (surface) => replaySafe?.recordSurface(withPlacement(surface, view)),
    surfaces: agentLaunchSurfaceFactory(
      context,
      replaySafe?.attachOperationId,
      replaySafe?.callerKey,
      callerNavigationId !== null,
      replaySafe?.terminalSpawn,
      view,
      hostFoundingAttempt
    ),
    ...agentLaunchWorkspaceCreation(context, intent),
    ...(callerRendersLaunchedChat(context, intent.agent) ? {} : { callerRendersStructured: false }),
    // The tab is shown as it is published, not after a prompt that can take a minute to land.
    onSurfacePublished: (surface) => {
      view.early?.surfacePublished(surface)
      if (callerNavigationId !== null && view.presentation !== 'background') {
        selectAgentLaunchTabForCaller(context.runtime, surface, callerNavigationId)
      }
    }
  })
  return withPlacement(result, view)
}

/**
 * The pre-ledger path, unchanged and kept for every caller that names no operation.
 *
 * `dedupeWorktreeCreate` is an in-memory 60-second window over the create half of a launch, keyed
 * on repo plus mutation id with no caller partition, and it dies with the process. That was the
 * only idempotency `agent.launch` ever had, and an existing-workspace launch never got even that.
 * It is deliberately NOT a second correctness authority now: once a caller supplies `operationId`,
 * durable admission encloses the whole operation and this cache is bypassed entirely, so there is
 * one place that decides whether a launch runs.
 */
export function runLegacyAgentLaunch(
  params: AgentLaunchParams,
  context: RpcContext
): Promise<AgentLaunchResult> {
  // No early tab, as before: only a replay-safe launch shows its tab before its agent exists.
  const execute = async () =>
    runAgentLaunch(await resolveUnlaunchedIntent(params, context.runtime, null), context, {
      early: null,
      presentation: params.presentation
    })
  if (params.target.kind === 'create-worktree' && params.target.create.clientMutationId) {
    const { repo, repoHostId } = params.target.create
    return context.runtime.dedupeWorktreeCreate(
      repoHostId ? { repo, repoHostId } : repo,
      `agent.launch:${params.target.create.clientMutationId}`,
      execute
    )
  }
  return execute()
}
