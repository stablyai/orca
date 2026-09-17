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

import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { computeAgentLaunchFingerprint } from '../../../../shared/agent-launch-operation'
import type {
  AgentLaunchIntent,
  AgentLaunchResult,
  AgentLaunchTarget
} from '../../../../shared/agent-launch-intent'
import { agentSessionOperationKey } from '../../../../shared/agent-session-operation-ledger'
import { executeAgentLaunch } from '../../../agent-launch/agent-launch-executor'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, type RpcContext } from '../core'
import { admitAgentLaunchOperation, agentLaunchOperationCallerKey } from './agent-launch-replay'
import { AgentLaunch, type AgentLaunchParams } from './agent-launch-schemas'
import { agentLaunchSurfaceFactory } from './agent-launch-surfaces'
import { agentLaunchWorkspaceFactory } from './agent-launch-worktree-creation'

/**
 * Advertising `agent.launch.v2` is a client's statement that it understands EITHER outcome — a
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
async function resolveUnlaunchedIntent(
  params: AgentLaunchParams,
  runtime: OrcaRuntimeService
): Promise<AgentLaunchIntent> {
  const intent = await agentLaunchIntent(params, runtime)
  await validateReusedTerminal(intent, runtime)
  return intent
}

function runAgentLaunch(
  intent: AgentLaunchIntent,
  context: RpcContext,
  attachOperationId?: string,
  operationCallerKey?: string
): Promise<AgentLaunchResult> {
  return executeAgentLaunch({
    runtime: context.runtime,
    intent,
    surfaces: agentLaunchSurfaceFactory(context, attachOperationId, operationCallerKey),
    workspaces: agentLaunchWorkspaceFactory(context, intent.agent)
  })
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
  const execute = async () =>
    runAgentLaunch(await resolveUnlaunchedIntent(params, context.runtime), context)
  if (params.target.kind === 'create-worktree' && params.target.create.clientMutationId) {
    return context.runtime.dedupeWorktreeCreate(
      params.target.create.repo,
      `agent.launch:${params.target.create.clientMutationId}`,
      execute
    )
  }
  return execute()
}

function settleQuietly(settlement: Promise<void>): Promise<void> {
  return settlement.catch((error: unknown) => {
    console.warn('[agent-launch] the launch settled, its operation row did not', error)
  })
}

/** Long enough for every code this path raises, with room for one a later guard adds. */
const LAUNCH_FAILURE_CODE_MAX_LENGTH = 128

/**
 * This path raises its refusals as the thrown code, the way the method's own guards do — and the
 * recorded code is what a replay answers with, so it is worth keeping.
 *
 * Bounded because a code is an identifier but `error.message` is free text: an errno sentence
 * carrying an absolute path arrives here as one, and it would be written into a ledger file that is
 * re-serialized whole on every subsequent operation. Bounded on the way IN only. A length check in
 * `isAgentSessionOperationRow` would reject rows this same build wrote, and one rejected row costs
 * the entire store.
 */
function agentLaunchFailureCode(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  return code.length > 0 ? code.slice(0, LAUNCH_FAILURE_CODE_MAX_LENGTH) : 'agent_launch_failed'
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
  const admission = await admitAgentLaunchOperation(context, params, fingerprint)
  if (admission.decision === 'refuse') {
    throw new Error(admission.refusal.code)
  }
  if (admission.decision === 'replay') {
    return admission.result
  }
  let intent: AgentLaunchIntent
  try {
    intent = await resolveUnlaunchedIntent(params, context.runtime)
  } catch (error) {
    await settleQuietly(admission.fail(agentLaunchFailureCode(error)))
    throw error
  }
  // Any later failure may follow a created surface, so the claimed row must stay `unknown`.
  const result = await runAgentLaunch(
    intent,
    context,
    admission.attachOperationId,
    admission.callerKey
  )
  // Settlement is bookkeeping; failure leaves the truthful `unknown` refusal for later retries.
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
    name: 'agent.launch',
    params: AgentLaunch,
    handler: async (params, context): Promise<AgentLaunchResult> => {
      if (!supportsAgentLaunch(context)) {
        throw new Error('agent_launch_unsupported')
      }
      if (!params.operationId) {
        return runLegacyAgentLaunch(params, context)
      }
      return runReplaySafeAgentLaunch(
        {
          ...params,
          operationId: params.operationId
        },
        context
      )
    }
  })
]
