/**
 * How a launch's execution ends for its caller and its record: the error that carries whether it
 * provably ran nothing, the bookkeeping that never fails a launch, and the answer for a launch whose
 * tab the user closed while it started.
 */

import {
  AGENT_LAUNCH_TAB_CLOSED_CODE,
  AgentLaunchTabClosedError
} from '../../../../shared/agent-launch-tab-closed'
import type { RpcContext } from '../core'
import {
  WorktreeCreateCollisionError,
  WORKTREE_CREATE_COLLISION_CODE
} from '../../../../shared/new-workspace/worktree-create-collision'
import { readsAgentLaunchTabClosed, readsAgentLaunchWorkspaceKept } from './agent-launch-replay'
import {
  AGENT_LAUNCH_AGENT_NOT_STARTED_CODE,
  AgentLaunchWorkspaceKeptError
} from '../../../../shared/agent-launch-agent-not-started'
import type { EarlyAgentLaunchTab } from './agent-launch-tab-publication'

export class AgentLaunchExecutionError extends Error {
  constructor(
    cause: unknown,
    /** Decided once, by the launch that ran; a later reader cannot re-derive it from the error. */
    readonly failedWithoutEffects: boolean
  ) {
    super('agent_session_operation_unknown', { cause })
  }
}

export function settleQuietly(settlement: Promise<void>): Promise<void> {
  return settlement.catch((error: unknown) => {
    console.warn('[agent-launch] the launch settled, its operation row did not', error)
  })
}

/** Runs a launch whose tab may already be showing. Its pane reads how the launch ended off the
 *  launch record, which every path below settles before this returns. */
export async function withEarlyTab<T>(
  early: EarlyAgentLaunchTab | null,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run()
  } finally {
    early?.finish()
  }
}

/** A create that kept its workspace but could not start its agent: named to a caller that reads it,
 *  with the reason the agent failed as its message; `otherwise` (the answer it got before) to any
 *  other. */
export function agentLaunchWorkspaceKeptAnswer(
  context: RpcContext,
  error: AgentLaunchWorkspaceKeptError,
  otherwise: unknown
): unknown {
  const reason =
    error.cause instanceof Error ? error.cause.message : AGENT_LAUNCH_AGENT_NOT_STARTED_CODE
  return readsAgentLaunchWorkspaceKept(context)
    ? Object.assign(new Error(reason), {
        code: AGENT_LAUNCH_AGENT_NOT_STARTED_CODE,
        data: { worktreeId: error.worktreeId }
      })
    : otherwise
}

/** What a caller hears for a launch whose tab the user closed: the definite answer when it reads
 *  that word, the uncertain one it always got otherwise. */
export function agentLaunchTabClosedAnswer(context: RpcContext): Error {
  return readsAgentLaunchTabClosed(context)
    ? Object.assign(new Error(AGENT_LAUNCH_TAB_CLOSED_CODE), { code: AGENT_LAUNCH_TAB_CLOSED_CODE })
    : new Error('agent_session_operation_unknown')
}

/** A launch whose tab the user closed while it started ends as exactly that: its agent, if one
 *  spawned, is stopped, and the record answers `agent_launch_tab_closed` to this caller and every
 *  retry. Throws that answer. */
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
  throw new AgentLaunchExecutionError(new AgentLaunchTabClosedError(), true)
}

/** What `agent.launchReplay` answers for a launch that failed. Nested failures cannot authorize
 *  another workspace, regardless of their message or code. */
export function launchReplayExecutionAnswer(
  context: RpcContext,
  error: AgentLaunchExecutionError
): unknown {
  if (error.cause instanceof WorktreeCreateCollisionError) {
    return Object.assign(new Error(error.cause.message, { cause: error.cause }), {
      code: WORKTREE_CREATE_COLLISION_CODE
    })
  }
  if (error.cause instanceof AgentLaunchTabClosedError) {
    return agentLaunchTabClosedAnswer(context)
  }
  const unknown = new Error('agent_session_operation_unknown', { cause: error.cause })
  if (error.cause instanceof AgentLaunchWorkspaceKeptError) {
    return agentLaunchWorkspaceKeptAnswer(context, error.cause, unknown)
  }
  return error.failedWithoutEffects ? error.cause : unknown
}
