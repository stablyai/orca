import {
  assertHostFoundingNotCancelled,
  type HostFoundingAttempt
} from '../../../agent-launch/host-founding-attempt'
import { AgentLaunchCancelledError } from '../../../../shared/agent-launch-cancellation'

import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { canonicalWorktreeIdentity } from '../../../../shared/worktree/identity'
import { worktreeCreateRepoSelector } from './worktree-create-args'

import type { AgentLaunchIntent, AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import { agentSessionOperationKey } from '../../../../shared/agent-session-operation-ledger'
import { WorktreeCreateCollisionError } from '../../../../shared/new-workspace/worktree-create-collision'

import { trackTerminalSpawnDispatch } from '../../../agent-launch/agent-launch-not-started'

import type { RpcContext } from '../core'
import { admitAgentLaunchOperation, agentLaunchOperationCallerKey } from './agent-launch-replay'
import {
  AgentLaunchExecutionError,
  agentLaunchRefusalError,
  settleLaunchWhoseTabWasClosed,
  settleQuietly,
  withEarlyTab
} from './agent-launch-execution-outcome'
import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'

import {
  agentLaunchFailureCode,
  launchFailureWithoutEffectsCode
} from './agent-launch-failure-code'

import { resolveUnlaunchedIntent } from './agent-launch-intent-resolution'
import { publishEarlyTab, type AgentLaunchView } from './agent-launch-tab-publication'

import type { ActiveAgentLaunch } from './agent-launch'
import { runAgentLaunch } from './agent-launch-run'
async function reserveAgentLaunchWorkspaceIdentity(
  params: AgentLaunchParams & { operationId: string },
  context: RpcContext,
  active: Map<string, ActiveAgentLaunch>
): Promise<void> {
  if (!params.createIdentity || params.target.kind !== 'create-worktree') {
    return
  }
  const repo = await context.runtime.showRepo(worktreeCreateRepoSelector(params.target.create))
  const hostId = getRepoExecutionHostId(repo)
  const { instanceId } = params.createIdentity
  const identity = canonicalWorktreeIdentity({
    worktreeId: '',
    executionHostId: hostId,
    instanceId
  })
  const ownKey = agentSessionOperationKey(
    agentLaunchOperationCallerKey(context),
    params.operationId
  )
  const owner = active.get(ownKey)
  if (!owner) {
    throw new Error('agent_session_operation_unknown')
  }
  const store = context.runtime.requireStore()
  if (!store.hasWorktreeInstanceForHost) {
    throw new Error('runtime_unavailable')
  }
  if (
    store.hasWorktreeInstanceForHost(instanceId, hostId) ||
    [...active.values()].some((other) => other !== owner && other.workspaceIdentity === identity)
  ) {
    throw new WorktreeCreateCollisionError('Workspace identity is already in use.')
  }
  owner.workspaceIdentity = identity
}

export async function executeReplaySafeAgentLaunch(
  params: AgentLaunchParams & { operationId: string },
  context: RpcContext,
  fingerprint: string,
  hostFoundingAttempt: HostFoundingAttempt,
  active: Map<string, ActiveAgentLaunch>
): Promise<AgentLaunchResult> {
  // The tab is the host's first act: admission has a cold cost the user should not watch.
  const early = await publishEarlyTab(params, context)
  let admission: Awaited<ReturnType<typeof admitAgentLaunchOperation>>
  try {
    admission = await admitAgentLaunchOperation(context, params, fingerprint, Date.now())
  } catch (error) {
    early?.finish()
    throw error
  }
  if (admission.decision !== 'execute') {
    // Nothing runs under this request. A tab it made goes, unless an agent still runs in its pane
    // (a replay can remake the tab of an agent that survived).
    early?.finish(
      admission.decision === 'refuse' &&
        admission.refusal.code !== 'agent_session_operation_unknown'
        ? admission.refusal.code
        : undefined
    )
    if (admission.decision === 'refuse') {
      throw agentLaunchRefusalError(admission.refusal)
    }
    return admission.result
  }
  assertHostFoundingNotCancelled(hostFoundingAttempt)
  early?.executing()
  return withEarlyTab(early, () =>
    executeAdmittedAgentLaunch(
      params,
      context,
      admission,
      {
        early,
        presentation: params.presentation
      },
      hostFoundingAttempt,
      active
    )
  )
}

async function executeAdmittedAgentLaunch(
  params: AgentLaunchParams & { operationId: string },
  context: RpcContext,
  admission: Extract<
    Awaited<ReturnType<typeof admitAgentLaunchOperation>>,
    { decision: 'execute' }
  >,
  view: AgentLaunchView,
  hostFoundingAttempt: HostFoundingAttempt,
  active: Map<string, ActiveAgentLaunch>
): Promise<AgentLaunchResult> {
  let intent: AgentLaunchIntent
  try {
    intent = await resolveUnlaunchedIntent(params, context.runtime, view.early)
  } catch (error) {
    if (hostFoundingAttempt.cancellation?.requested) {
      throw new AgentLaunchCancelledError()
    }
    await settleQuietly(admission.fail(agentLaunchFailureCode(error)))
    throw error
  }
  const terminalSpawn = trackTerminalSpawnDispatch()
  let result: AgentLaunchResult
  try {
    await reserveAgentLaunchWorkspaceIdentity(params, context, active)
    result = await runAgentLaunch(
      intent,
      context,
      view,
      {
        attachOperationId: admission.attachOperationId,
        callerKey: admission.callerKey,
        terminalSpawn,
        recordSurface: (provisional) => {
          if (!hostFoundingAttempt.cancellation?.requested) {
            void settleQuietly(admission.record(provisional))
          }
        }
      },
      hostFoundingAttempt
    )
  } catch (error) {
    if (hostFoundingAttempt.cancellation?.requested) {
      throw new AgentLaunchCancelledError()
    }
    if (!hostFoundingAttempt.disposition && view.early?.closedByUser()) {
      await settleLaunchWhoseTabWasClosed(context, view.early, admission)
    }
    const failedWithoutEffects = hostFoundingAttempt.disposition
      ? null
      : launchFailureWithoutEffectsCode(error, intent.target.kind, terminalSpawn)
    if (failedWithoutEffects) {
      await settleQuietly(admission.fail(failedWithoutEffects, error))
    }
    throw new AgentLaunchExecutionError(
      error,
      failedWithoutEffects,
      hostFoundingAttempt.createdWorktreeId
    )
  }
  if (!hostFoundingAttempt.disposition && view.early?.closedByUser()) {
    // The user closed its tab after the spawn left: the agent stops, as any closed tab's does.
    await settleLaunchWhoseTabWasClosed(context, view.early, admission)
  }
  // Bookkeeping: a failure leaves the first write, whose owed prompt replays as `unconfirmed` (or as
  // `unknown` to a caller that cannot read it), never as `not-delivered`.
  if (!hostFoundingAttempt.cancellation?.requested) {
    await settleQuietly(admission.settle(result))
  }
  return result
}
