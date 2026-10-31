import type { HostLaunchContext } from './agent-launch'
import type { HostFoundingAttempt } from '../../../agent-launch/host-founding-attempt'

import type { AgentLaunchResult } from '../../../../shared/agent-launch-intent'

import { executeAgentLaunch } from '../../../agent-launch/agent-launch-executor'
import type { TerminalSpawnDispatch } from '../../../agent-launch/agent-launch-not-started'

import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'
import { agentLaunchSurfaceFactory } from './agent-launch-surfaces'

import {
  agentLaunchCallerNavigationId,
  callerRendersLaunchedChat,
  selectAgentLaunchTabForCaller
} from './agent-launch-caller-selection'
import { agentLaunchWorkspaceCreation } from './agent-launch-worktree-creation'

import { resolveUnlaunchedIntent } from './agent-launch-intent-resolution'
import { withPlacement, type AgentLaunchView } from './agent-launch-tab-publication'

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
  { intent, decidedMode }: Awaited<ReturnType<typeof resolveUnlaunchedIntent>>,
  context: HostLaunchContext,
  view: AgentLaunchView,
  replaySafe?: ReplaySafeLaunch,
  hostFoundingAttempt: HostFoundingAttempt = {}
): Promise<AgentLaunchResult> {
  const callerNavigationId = agentLaunchCallerNavigationId(intent.target, context)
  const result = await executeAgentLaunch({
    runtime: context.runtime,
    intent,
    decidedMode,
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
    // The tab is shown as it is published, not after a prompt that can take a minute to land.
    onSurfacePublished: (surface) => {
      try {
        context.agentLaunchPolicy?.onSurfacePublished?.(surface)
      } catch (error) {
        console.warn('[agent-launch] publication bookkeeping failed', error)
      }
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
  context: HostLaunchContext
): Promise<AgentLaunchResult> {
  // No early tab, as before: only a replay-safe launch shows its tab before its agent exists.
  const execute = async () =>
    runAgentLaunch(
      await resolveUnlaunchedIntent(params, context.runtime, null, {
        callerRendersStructured: callerRendersLaunchedChat(context, params.agent)
      }),
      context,
      {
        early: null,
        presentation: params.presentation
      }
    )
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
