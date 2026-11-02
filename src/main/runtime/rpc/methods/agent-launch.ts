import { activeAgentLaunchesFor } from './agent-launch-in-flight'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
/** Capability-gated surface routing; callers must inspect outcome.kind and receipt for fallback reasons.
 * Keep worktree.create's PTY/handle contract for older clients.
 * operationId adds durable at-most-once execution and recorded replay; unknown outcomes refuse, while stranded-surface recovery remains separate. */

import { agentLaunchFeatureRequirement } from '../agent-launch-feature-requirement'
import { AgentLaunchTabClosedError } from '../../../../shared/agent-launch-tab-closed'
import { computeAgentLaunchFingerprint } from '../../../../shared/agent-launch-operation'
import type { AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import { agentSessionOperationKey } from '../../../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import { executeAgentLaunch } from '../../../agent-launch/agent-launch-executor'
import { trackTerminalSpawnDispatch } from '../../../agent-launch/agent-launch-not-started'
import { defineMethod, type RpcContext } from '../core'
import {
  admitAgentLaunchOperation,
  agentLaunchOperationCallerKey,
  type AcceptedAgentLaunch,
  type ReplaySafeLaunch
} from './agent-launch-replay'
import {
  AgentLaunchExecutionError,
  agentLaunchRefusalError,
  agentLaunchTabClosedAnswer,
  launchReplayAnswer,
  settleLaunchWhoseTabWasClosed,
  settleQuietly,
  withEarlyTab
} from './agent-launch-execution-outcome'
import {
  AgentLaunch,
  AgentLaunchReplay,
  type AgentLaunchParams
} from '../../../../shared/rpc-contract/agent-launch-params'
import { agentLaunchSurfaceFactory } from './agent-launch-surfaces'
import { prepareAgentHandoffCard } from './agent-launch-handoff-card'
import {
  agentLaunchFailureCode,
  launchFailureWithoutEffectsCode
} from './agent-launch-failure-code'
import {
  agentLaunchCallerNavigationId,
  callerRendersLaunchedChat,
  selectAgentLaunchTabForCaller
} from './agent-launch-caller-selection'
import { agentLaunchWorkspaceFactory } from './agent-launch-worktree-creation'
import {
  assertAgentLaunchTargetAuthorized,
  supportsAgentLaunch
} from './agent-launch-target-authorization'
import { resolveUnlaunchedIntent } from './agent-launch-intent-resolution'
import {
  publishEarlyTab,
  withPlacement,
  type AgentLaunchView
} from './agent-launch-tab-publication'

export { supportsAgentLaunch } from './agent-launch-target-authorization'

type HostLaunchContext = RpcContext & {
  agentLaunchPolicy?: { onSurfacePublished?: (surface: AgentLaunchResult) => void }
}

async function runAgentLaunch(
  { intent, decidedMode }: Awaited<ReturnType<typeof resolveUnlaunchedIntent>>,
  context: HostLaunchContext,
  view: AgentLaunchView,
  replaySafe?: ReplaySafeLaunch
): Promise<AgentLaunchResult> {
  const callerNavigationId = agentLaunchCallerNavigationId(intent.target, context)
  const result = await executeAgentLaunch({
    runtime: context.runtime,
    intent,
    decidedMode,
    ...(replaySafe?.acceptance ? { acceptance: replaySafe.acceptance } : {}),
    surfaces: agentLaunchSurfaceFactory(
      context,
      replaySafe?.attachOperationId,
      replaySafe?.callerKey,
      callerNavigationId !== null,
      replaySafe?.terminalSpawn,
      view
    ),
    workspaces: agentLaunchWorkspaceFactory(context, intent.agent),
    // The tab is shown as it is published, not after a prompt that can take a minute to land.
    onSurfacePublished: (surface) => {
      try {
        context.agentLaunchPolicy?.onSurfacePublished?.(surface)
      } catch (error) {
        console.warn('[agent-launch] publication bookkeeping failed', error)
      }
      view.early?.surfacePublished(surface)
      replaySafe?.recordSurface(withPlacement(surface, view))
      if (callerNavigationId !== null && view.presentation !== 'background') {
        selectAgentLaunchTabForCaller(context.runtime, surface, callerNavigationId)
      }
    }
  })
  return withPlacement(result, view)
}

/** Legacy unnamed launches retain the 60-second create dedupe cache (repo/mutation id, no caller partition).
 * Named operations bypass it: durable admission alone decides execution, including existing-workspace launches. */
function runLegacyAgentLaunch(
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

async function executeReplaySafeAgentLaunch(
  params: AgentLaunchParams & { operationId: string },
  context: HostLaunchContext,
  fingerprint: string,
  accepted?: AcceptedAgentLaunch
): Promise<AgentLaunchResult> {
  // The tab is the host's first act: admission has a cold cost the user should not watch.
  // An accepted launch publishes nothing before dispatch; its caller shows its own pending surface.
  const early = accepted ? null : await publishEarlyTab(params, context)
  let admission: Awaited<ReturnType<typeof admitAgentLaunchOperation>>
  try {
    admission = await admitAgentLaunchOperation(context, params, fingerprint, Date.now())
  } catch (error) {
    early?.finish()
    throw error
  }
  accepted?.onAdmitted(admission)
  if (admission.decision !== 'execute') {
    // No effect runs on refusal; remove only this request's empty tab, never a pane that survived for replay.
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
  early?.executing()
  return withEarlyTab(early, () =>
    executeAdmittedAgentLaunch(params, context, admission, {
      early,
      presentation: params.presentation,
      ...(accepted ? { acceptance: accepted.acceptance } : {})
    })
  )
}

async function executeAdmittedAgentLaunch(
  params: AgentLaunchParams & { operationId: string },
  context: HostLaunchContext,
  admission: Extract<
    Awaited<ReturnType<typeof admitAgentLaunchOperation>>,
    { decision: 'execute' }
  >,
  // An accepted launch's Setup and close travel with its view into the execution.
  { acceptance, ...view }: AgentLaunchView & Pick<ReplaySafeLaunch, 'acceptance'>
): Promise<AgentLaunchResult> {
  let resolved: Awaited<ReturnType<typeof resolveUnlaunchedIntent>>
  try {
    resolved = await resolveUnlaunchedIntent(params, context.runtime, view.early, {
      callerRendersStructured: callerRendersLaunchedChat(context, params.agent),
      afterSetup: acceptance !== undefined
    })
  } catch (error) {
    await settleQuietly(admission.fail(agentLaunchFailureCode(error), error))
    throw error
  }
  const terminalSpawn = trackTerminalSpawnDispatch()
  const handedOff = prepareAgentHandoffCard(params, context)
  let result: AgentLaunchResult
  try {
    result = await runAgentLaunch(resolved, context, view, {
      attachOperationId: admission.attachOperationId,
      callerKey: admission.callerKey,
      terminalSpawn,
      recordSurface: (provisional) => void settleQuietly(admission.record(provisional)),
      ...(acceptance ? { acceptance } : {})
    })
  } catch (error) {
    if (view.early?.closedByUser()) {
      await settleLaunchWhoseTabWasClosed(context, view.early, admission)
    }
    const failedWithoutEffects = launchFailureWithoutEffectsCode(
      error,
      resolved.intent.target.kind,
      terminalSpawn
    )
    if (failedWithoutEffects) {
      await settleQuietly(admission.fail(failedWithoutEffects, error))
    }
    throw new AgentLaunchExecutionError(error, failedWithoutEffects)
  }
  if (view.early?.closedByUser()) {
    // The user closed its tab after the spawn left: the agent stops, as any closed tab's does.
    await settleLaunchWhoseTabWasClosed(context, view.early, admission)
  }
  // Failed settlement leaves the provisional prompt unconfirmed (unknown for older callers), never not-delivered that invites duplication.
  await settleQuietly(admission.settle(result))
  return handedOff(result)
}

/** One in-process execution per caller operation: a retry or an accepted launch's read joins it. */
export function runReplaySafeAgentLaunch(
  params: AgentLaunchParams & { operationId: string },
  context: HostLaunchContext,
  accepted?: AcceptedAgentLaunch
): Promise<AgentLaunchResult> {
  const callerKey = agentLaunchOperationCallerKey(context)
  const key = agentSessionOperationKey(callerKey, params.operationId)
  const fingerprint = computeAgentLaunchFingerprint(params)
  const activeAgentLaunches = activeAgentLaunchesFor(context.runtime)
  const active = activeAgentLaunches.get(key)
  if (active) {
    if (active.fingerprint !== fingerprint) {
      return Promise.reject(new Error('agent_session_operation_conflict'))
    }
    return active.promise
  }

  let promise: Promise<AgentLaunchResult>
  promise = executeReplaySafeAgentLaunch(params, context, fingerprint, accepted).finally(() => {
    if (activeAgentLaunches.get(key)?.promise === promise) {
      activeAgentLaunches.delete(key)
    }
  })
  activeAgentLaunches.set(key, { fingerprint, promise })
  return promise
}

export const AGENT_LAUNCH_METHODS = [
  defineMethod({
    name: 'agent.launchReplay',
    requires: agentLaunchFeatureRequirement,
    permission: 'workspace',
    params: AgentLaunchReplay,
    handler: async (params, context): Promise<AgentLaunchResult> => {
      if (!supportsAgentLaunch(context)) {
        throw new Error('agent_launch_replay_unsupported')
      }
      assertAgentLaunchTargetAuthorized(params.target, context)
      try {
        return await waitForPromiseWithSignal(
          runReplaySafeAgentLaunch(params, context),
          context.signal
        )
      } catch (error) {
        throw launchReplayAnswer(error, context)
      }
    }
  }),
  defineMethod({
    name: 'agent.launch',
    requires: agentLaunchFeatureRequirement,
    permission: 'workspace',
    params: AgentLaunch,
    handler: (params, context) =>
      waitForPromiseWithSignal(launchAgentOnHost(params, context), context.signal)
  })
]

/** In-process schedules and RPC callers share admission, factories and prompt settlement. */
export async function launchAgentOnHost(
  { operationId, ...params }: AgentLaunchParams,
  context: RpcContext,
  policy?: HostLaunchContext['agentLaunchPolicy']
): Promise<AgentLaunchResult> {
  const host = { ...context, agentLaunchPolicy: policy }
  if (!supportsAgentLaunch(host)) {
    throw new Error('agent_launch_unsupported')
  }
  assertAgentLaunchTargetAuthorized(params.target, host)
  if (!operationId) {
    return runLegacyAgentLaunch(params, host)
  }
  return runReplaySafeAgentLaunch({ ...params, operationId }, host).catch((error: unknown) => {
    // Preserve the original error contract for callers of the optional-identity method.
    if (error instanceof AgentLaunchExecutionError) {
      throw error.cause instanceof AgentLaunchTabClosedError
        ? agentLaunchTabClosedAnswer(host)
        : error.cause
    }
    throw error
  })
}
