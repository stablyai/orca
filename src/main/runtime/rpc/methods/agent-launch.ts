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
 *
 * A launch is also the one call whose retry is most expensive to get wrong — a lost reply means the
 * caller cannot tell "never ran" from "ran, answer lost" — so a caller may name the operation with
 * `operationId` and get exactly one execution, a recorded answer on every replay, and a refusal
 * when the outcome is genuinely unknown. That guarantee is safety, not recovery: it makes a retry
 * harmless, and does nothing to reunite a caller with a surface a dead attempt left behind.
 */

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

/**
 * Advertising `agent.launch.v2` is a client's statement that it understands EITHER outcome — a
 * structured session it can open, or a terminal agent. A client that can only render one of the
 * two must keep using the surface-specific methods instead. The `clientKind === undefined` branch
 * is not "whatever ships in this build": it is the `orca` CLI over the runtime socket and the
 * SSH-remote CLI bridges, which carry no capability list at all. The desktop renderer ships in
 * this build and still arrives as `clientKind: 'runtime'`, so it advertises like any other client.
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
      view.early
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
function runLegacyAgentLaunch(
  params: AgentLaunchParams,
  context: RpcContext
): Promise<AgentLaunchResult> {
  // No early tab: without a launch record its pane could not learn how the launch ended.
  const execute = async () =>
    runAgentLaunch(await resolveUnlaunchedIntent(params, context.runtime, null), context, {
      early: null,
      presentation: params.presentation
    })
  if (params.target.kind === 'create-worktree' && params.target.create.clientMutationId) {
    return context.runtime.dedupeWorktreeCreate(
      params.target.create.repo,
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
  const existing = activeAgentLaunchesByRuntime.get(runtime)
  if (existing) {
    return existing
  }
  const active = new Map<string, ActiveAgentLaunch>()
  activeAgentLaunchesByRuntime.set(runtime, active)
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
    admission = await admitAgentLaunchOperation(
      context,
      params,
      fingerprint,
      Date.now(),
      early?.ownedPane
    )
  } catch (error) {
    early?.finish()
    throw error
  }
  if (admission.decision !== 'execute') {
    // Nothing runs under this request. A tab it made goes, unless an agent still runs in its pane
    // (a replay can remake the tab of an agent that survived).
    early?.finish()
    if (admission.decision === 'refuse') {
      throw Object.assign(new Error(admission.refusal.code), { code: admission.refusal.code })
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
      await settleQuietly(admission.fail(failedWithoutEffects))
    }
    throw new AgentLaunchExecutionError(error, failedWithoutEffects !== null)
  }
  if (view.early?.closedByUser()) {
    // The user closed its tab after the spawn left: the agent stops, as any closed tab's does.
    await settleLaunchWhoseTabWasClosed(context, view.early, admission)
  }
  // Bookkeeping: a failure leaves the first write, whose owed prompt replays as `unconfirmed` (or as
  // `unknown` to a caller that cannot read it), never as `not-delivered`.
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
