import { AgentLaunchSetupNotCompletedError } from '../../setup/setup-run'
import {
  AGENT_LAUNCH_TAB_CLOSED_CODE,
  AgentLaunchTabClosedError
} from '../../../../shared/agent-launch-tab-closed'
import type { RpcContext } from '../core'
import { readsAgentLaunchTabClosed, type AgentLaunchRefusal } from './agent-launch-replay'
import type { EarlyAgentLaunchTab } from './agent-launch-tab-publication'
import { agentLaunchFailureCode } from './agent-launch-failure-code'
import {
  WorktreeCreateCollisionError,
  WORKTREE_CREATE_COLLISION_CODE
} from '../../../../shared/new-workspace/worktree-create-collision'

export class AgentLaunchExecutionError extends Error {
  constructor(
    cause: unknown,
    /** Decided by the executing launch: a recorded code proves no effects; later readers cannot re-derive that proof. */
    readonly failureCode: string | null
  ) {
    super('agent_session_operation_unknown', { cause })
  }

  get failedWithoutEffects(): boolean {
    return this.failureCode !== null
  }
}

/** A replayed refusal, in the words it was refused with when its record kept them. */
export function agentLaunchRefusalError(refusal: AgentLaunchRefusal): Error {
  return Object.assign(new Error(refusal.said ?? refusal.code), { code: refusal.code })
}

export function settleQuietly(settlement: Promise<void>): Promise<void> {
  return settlement.catch((error: unknown) => {
    console.warn('[agent-launch] the launch settled, its operation row did not', error)
  })
}

/** Tell an early pane whether launch failed definitively or its start remains unconfirmed. */
export async function withEarlyTab<T>(
  early: EarlyAgentLaunchTab | null,
  run: () => Promise<T>
): Promise<T> {
  try {
    const result = await run()
    early?.finish()
    return result
  } catch (error) {
    early?.finish(
      error instanceof AgentLaunchExecutionError
        ? error.cause instanceof AgentLaunchSetupNotCompletedError
          ? error.cause.code
          : error.failureCode
        : error instanceof AgentLaunchSetupNotCompletedError
          ? error.code
          : agentLaunchFailureCode(error)
    )
    throw error
  }
}

/** What agent.launchReplay answers for a failed launch.
 * Nested failures cannot authorize another workspace, regardless of their message or code. */
export function launchReplayAnswer(error: unknown, context: RpcContext): unknown {
  if (!(error instanceof AgentLaunchExecutionError)) {
    return error
  }
  if (error.cause instanceof AgentLaunchSetupNotCompletedError) {
    return error.cause
  }
  if (error.cause instanceof WorktreeCreateCollisionError) {
    return Object.assign(new Error(error.cause.message, { cause: error.cause }), {
      code: WORKTREE_CREATE_COLLISION_CODE
    })
  }
  if (error.cause instanceof AgentLaunchTabClosedError) {
    return agentLaunchTabClosedAnswer(context)
  }
  if (error.failedWithoutEffects) {
    return error.cause
  }
  return new Error('agent_session_operation_unknown', { cause: error.cause })
}

/** Use the definite tab-closed answer only for callers that understand it; older callers retain uncertainty. */
export function agentLaunchTabClosedAnswer(context: RpcContext): Error {
  return readsAgentLaunchTabClosed(context)
    ? Object.assign(new Error(AGENT_LAUNCH_TAB_CLOSED_CODE), { code: AGENT_LAUNCH_TAB_CLOSED_CODE })
    : new Error('agent_session_operation_unknown')
}

/** Stop any spawned agent and record tab-closed for this launch and every retry; throws the caller-compatible answer. */
export async function settleLaunchWhoseTabWasClosed(
  context: RpcContext,
  early: EarlyAgentLaunchTab,
  admission: { fail: (code: string) => Promise<void> }
): Promise<never> {
  const handle = context.runtime.getTerminalHandleForPaneKey(early.paneKey)
  if (handle) {
    await context.runtime.closeTerminal(handle).catch(() => {})
  }
  await settleQuietly(admission.fail(AGENT_LAUNCH_TAB_CLOSED_CODE))
  throw new AgentLaunchExecutionError(new AgentLaunchTabClosedError(), AGENT_LAUNCH_TAB_CLOSED_CODE)
}
