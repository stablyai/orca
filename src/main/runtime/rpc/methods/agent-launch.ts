/** Capability-gated surface routing; callers must inspect outcome.kind and receipt for fallback reasons.
 * Keep worktree.create's PTY/handle contract for older clients.
 * operationId adds durable at-most-once execution and recorded replay; unknown outcomes refuse, while stranded-surface recovery remains separate. */

import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import { AgentLaunchTabClosedError } from '../../../../shared/agent-launch-tab-closed'
import { computeAgentLaunchFingerprint } from '../../../../shared/agent-launch-operation'
import type { AgentLaunchIntent, AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import { agentSessionOperationKey } from '../../../../shared/agent-session-operation-ledger'
import {
  WorktreeCreateCollisionError,
  WORKTREE_CREATE_COLLISION_CODE
} from '../../../../shared/new-workspace/worktree-create-collision'
import { executeAgentLaunch } from '../../../agent-launch/agent-launch-executor'
import {
  trackTerminalSpawnDispatch,
  type TerminalSpawnDispatch
} from '../../../agent-launch/agent-launch-not-started'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, type RpcContext } from '../core'
import { admitAgentLaunchOperation, agentLaunchOperationCallerKey } from './agent-launch-replay'
import {
  AgentLaunchExecutionError,
  agentLaunchRefusalError,
  agentLaunchTabClosedAnswer,
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
import {
  agentLaunchFailureCode,
  launchFailureWithoutEffectsCode
} from './agent-launch-failure-code'
import {
  agentLaunchCallerNavigationId,
  selectAgentLaunchTabForCaller
} from './agent-launch-caller-selection'
import { agentLaunchWorkspaceFactory } from './agent-launch-worktree-creation'
import { assertAgentLaunchTargetAuthorized } from './agent-launch-target-authorization'
import { clientRendersStructuredAgent } from './structured-agent-session-policy'
import { resolveUnlaunchedIntent } from './agent-launch-intent-resolution'
import {
  publishEarlyTab,
  withPlacement,
  type AgentLaunchView
} from './agent-launch-tab-publication'

/** agent.launch.v2 declares support for both outcomes. CLI/runtime-socket and SSH bridges have no clientKind/capabilities; the desktop renderer is a runtime client and must advertise support. */
export function supportsAgentLaunch(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(AGENT_LAUNCH_RUNTIME_CAPABILITY) === true
  )
}

/** v2 covers Claude/Codex chats; other agents require the same explicit rendering capability used by tabs and restart offers, else use terminal. */
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
  /** Queue provisional surface/prompt recording without awaiting it; ordered ledger transactions keep final settlement after it. */
  recordSurface: (provisional: AgentLaunchResult) => void
}

async function runAgentLaunch(
  intent: AgentLaunchIntent,
  context: RpcContext,
  view: AgentLaunchView,
  replaySafe?: ReplaySafeLaunch
): Promise<AgentLaunchResult> {
  const callerNavigationId = agentLaunchCallerNavigationId(intent.target, context)
  const result = await executeAgentLaunch({
    runtime: context.runtime,
    intent,
    surfaces: agentLaunchSurfaceFactory(
      context,
      replaySafe?.attachOperationId,
      replaySafe?.callerKey,
      callerNavigationId !== null,
      replaySafe?.terminalSpawn,
      view
    ),
    workspaces: agentLaunchWorkspaceFactory(context, intent.agent),
    ...(callerRendersLaunchedChat(context, intent.agent) ? {} : { callerRendersStructured: false }),
    // The tab is shown as it is published, not after a prompt that can take a minute to land.
    onSurfacePublished: (surface) => {
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

type ActiveAgentLaunch = {
  fingerprint: string
  promise: Promise<AgentLaunchResult>
}

const activeAgentLaunchesByRuntime = new WeakMap<
  OrcaRuntimeService,
  Map<string, ActiveAgentLaunch>
>()

function activeAgentLaunchesFor(runtime: OrcaRuntimeService): Map<string, ActiveAgentLaunch> {
  let active = activeAgentLaunchesByRuntime.get(runtime)
  if (!active) {
    active = new Map()
    activeAgentLaunchesByRuntime.set(runtime, active)
  }
  return active
}

async function executeReplaySafeAgentLaunch(
  params: AgentLaunchParams & { operationId: string },
  context: RpcContext,
  fingerprint: string
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
      presentation: params.presentation
    })
  )
}

async function executeAdmittedAgentLaunch(
  params: AgentLaunchParams & { operationId: string },
  context: RpcContext,
  admission: Extract<
    Awaited<ReturnType<typeof admitAgentLaunchOperation>>,
    { decision: 'execute' }
  >,
  view: AgentLaunchView
): Promise<AgentLaunchResult> {
  let intent: AgentLaunchIntent
  try {
    intent = await resolveUnlaunchedIntent(params, context.runtime, view.early)
  } catch (error) {
    await settleQuietly(admission.fail(agentLaunchFailureCode(error)))
    throw error
  }
  const terminalSpawn = trackTerminalSpawnDispatch()
  let result: AgentLaunchResult
  try {
    result = await runAgentLaunch(intent, context, view, {
      attachOperationId: admission.attachOperationId,
      callerKey: admission.callerKey,
      terminalSpawn,
      recordSurface: (provisional) => void settleQuietly(admission.record(provisional))
    })
  } catch (error) {
    if (view.early?.closedByUser()) {
      await settleLaunchWhoseTabWasClosed(context, view.early, admission)
    }
    const failedWithoutEffects = launchFailureWithoutEffectsCode(
      error,
      intent.target.kind,
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
  return result
}

function runReplaySafeAgentLaunch(
  params: AgentLaunchParams & { operationId: string },
  context: RpcContext
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
  promise = executeReplaySafeAgentLaunch(params, context, fingerprint).finally(() => {
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
    permission: 'workspace',
    params: AgentLaunchReplay,
    handler: async (params, context): Promise<AgentLaunchResult> => {
      if (!supportsAgentLaunch(context)) {
        throw new Error('agent_launch_replay_unsupported')
      }
      assertAgentLaunchTargetAuthorized(params.target, context)
      try {
        return await runReplaySafeAgentLaunch(params, context)
      } catch (error) {
        // Nested failures cannot authorize another workspace, regardless of their message or code.
        if (error instanceof AgentLaunchExecutionError) {
          if (error.cause instanceof WorktreeCreateCollisionError) {
            throw Object.assign(new Error(error.cause.message, { cause: error.cause }), {
              code: WORKTREE_CREATE_COLLISION_CODE
            })
          }
          if (error.cause instanceof AgentLaunchTabClosedError) {
            throw agentLaunchTabClosedAnswer(context)
          }
          if (error.failedWithoutEffects) {
            throw error.cause
          }
          throw new Error('agent_session_operation_unknown', { cause: error.cause })
        }
        throw error
      }
    }
  }),
  defineMethod({
    name: 'agent.launch',
    permission: 'workspace',
    params: AgentLaunch,
    handler: async (params, context): Promise<AgentLaunchResult> => {
      if (!supportsAgentLaunch(context)) {
        throw new Error('agent_launch_unsupported')
      }
      assertAgentLaunchTargetAuthorized(params.target, context)
      if (!params.operationId) {
        return runLegacyAgentLaunch(params, context)
      }
      return runReplaySafeAgentLaunch(
        {
          ...params,
          operationId: params.operationId
        },
        context
      ).catch((error: unknown) => {
        // Preserve the original error contract for callers of the optional-identity method.
        if (error instanceof AgentLaunchExecutionError) {
          throw error.cause instanceof AgentLaunchTabClosedError
            ? agentLaunchTabClosedAnswer(context)
            : error.cause
        }
        throw error
      })
    }
  })
]
