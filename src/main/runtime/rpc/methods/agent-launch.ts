import { runLegacyAgentLaunch } from './agent-launch-run'
import { executeReplaySafeAgentLaunch } from './agent-launch-replay-execution'
import { cancelAgentLaunch } from './agent-launch-cancel'
import {
  assertHostFoundingNotCancelled,
  type HostFoundingAttempt
} from '../../../agent-launch/host-founding-attempt'
import {
  AgentLaunchCancelledError,
  type AgentLaunchCancelResult
} from '../../../../shared/agent-launch-cancellation'
import {
  agentSessionOperationKey,
  agentSessionOperationExpiry
} from '../../../../shared/agent-session-operation-ledger'
import { parseAgentSessionOperationTimestamp } from '../../../../shared/agent-session-host-authority'

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

import {
  AGENT_LAUNCH_DESKTOP_CREATE_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_RUNTIME_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
import {
  AGENT_LAUNCH_TAB_CLOSED_CODE,
  AgentLaunchTabClosedError
} from '../../../../shared/agent-launch-tab-closed'
import { computeAgentLaunchFingerprint } from '../../../../shared/agent-launch-operation'
import type { AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import {
  WorktreeCreateCollisionError,
  WORKTREE_CREATE_COLLISION_CODE
} from '../../../../shared/new-workspace/worktree-create-collision'

import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, type RpcContext } from '../core'
import { agentLaunchOperationCallerKey, presentAgentLaunchResult } from './agent-launch-replay'
import {
  AgentLaunchExecutionError,
  AgentLaunchDesktopCreateError,
  agentLaunchTabClosedAnswer
} from './agent-launch-execution-outcome'
import {
  AgentLaunch,
  AgentLaunchReplay,
  AgentLaunchCancel,
  type AgentLaunchParams
} from '../../../../shared/rpc-contract/agent-launch-params'

import { assertAgentLaunchTargetAuthorized } from './agent-launch-target-authorization'

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

export type ActiveAgentLaunch = {
  hostFoundingAttempt: HostFoundingAttempt
  fingerprint: string
  workspaceIdentity?: string
  promise: Promise<AgentLaunchResult>
  cancelPromise?: Promise<AgentLaunchCancelResult>
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

  const hostFoundingAttempt: HostFoundingAttempt = AgentLaunchCancel.safeParse(params).success
    ? { cancellation: { controller: new AbortController(), requested: false, retain: false } }
    : {}
  if (hostFoundingAttempt.cancellation) {
    hostFoundingAttempt.beforeWrite = () => assertHostFoundingNotCancelled(hostFoundingAttempt)
  }
  let promise: Promise<AgentLaunchResult>
  promise = Promise.resolve()
    .then(() =>
      executeReplaySafeAgentLaunch(
        params,
        context,
        fingerprint,
        hostFoundingAttempt,
        activeAgentLaunches
      )
    )
    .catch((error: unknown) => {
      if (error instanceof AgentLaunchCancelledError && hostFoundingAttempt.cancellation?.retain) {
        throw new Error('agent_session_operation_unknown', { cause: error })
      }
      throw error
    })
    .finally(() => {
      if (activeAgentLaunches.get(key)?.promise === promise) {
        if (hostFoundingAttempt.cancellation?.retain) {
          const timestamp = parseAgentSessionOperationTimestamp(params.operationId)
          const delay =
            agentSessionOperationExpiry(timestamp ?? Date.now(), Date.now()) - Date.now()
          setTimeout(() => {
            if (activeAgentLaunches.get(key)?.promise === promise) {
              activeAgentLaunches.delete(key)
            }
          }, delay).unref()
        } else {
          activeAgentLaunches.delete(key)
        }
      }
    })
  activeAgentLaunches.set(key, { fingerprint, promise, hostFoundingAttempt })
  return promise
}

export const AGENT_LAUNCH_METHODS = [
  defineMethod({
    name: 'agent.launchCancel',
    permission: 'workspace',
    params: AgentLaunchCancel,
    handler: async (params, context): Promise<AgentLaunchCancelResult> => {
      if (
        context.clientKind !== 'runtime' ||
        (context.caller?.kind !== 'desktop' && context.caller?.kind !== 'paired-device') ||
        !supportsAgentLaunch(context)
      ) {
        throw new Error('forbidden')
      }
      assertAgentLaunchTargetAuthorized(params.target, context)
      const result = await cancelAgentLaunch(
        params,
        context,
        activeAgentLaunchesFor(context.runtime)
      )
      return result.result
        ? { ...result, result: presentAgentLaunchResult(context, result.result) }
        : result
    }
  }),
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
        return presentAgentLaunchResult(context, await runReplaySafeAgentLaunch(params, context))
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === AGENT_LAUNCH_TAB_CLOSED_CODE
        ) {
          throw agentLaunchTabClosedAnswer(context)
        }
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
          const unknown = new Error('agent_session_operation_unknown', { cause: error.cause })
          if (
            params.createIdentity &&
            error.createdWorktreeId &&
            (context.clientKind === undefined ||
              context.clientCapabilities?.includes(AGENT_LAUNCH_DESKTOP_CREATE_RUNTIME_CAPABILITY))
          ) {
            throw new AgentLaunchDesktopCreateError(unknown, error.createdWorktreeId)
          }
          throw unknown
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
      const launched = !params.operationId
        ? runLegacyAgentLaunch(params, context)
        : runReplaySafeAgentLaunch(
            {
              ...params,
              operationId: params.operationId
            },
            context
          )
      return launched
        .then((result) => presentAgentLaunchResult(context, result))
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === AGENT_LAUNCH_TAB_CLOSED_CODE
          ) {
            throw agentLaunchTabClosedAnswer(context)
          }
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
