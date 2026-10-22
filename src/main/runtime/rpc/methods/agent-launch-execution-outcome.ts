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
import { readsAgentLaunchTabClosed, type AgentLaunchRefusal } from './agent-launch-replay'
import type { EarlyAgentLaunchTab } from './agent-launch-tab-publication'
import { agentLaunchFailureCode } from './agent-launch-failure-code'

export class AgentLaunchExecutionError extends Error {
  constructor(
    cause: unknown,
    /** The recorded code when the launch provably ran nothing, else null. Decided once, by the
     *  launch that ran; a later reader cannot re-derive it from the error. */
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

/** Runs a launch whose tab may already be showing, and tells its pane how the launch ended: why,
 *  when it definitely failed; that it couldn't confirm the start when its outcome is unknown. */
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
      error instanceof AgentLaunchExecutionError ? error.failureCode : agentLaunchFailureCode(error)
    )
    throw error
  }
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
  throw new AgentLaunchExecutionError(new AgentLaunchTabClosedError(), AGENT_LAUNCH_TAB_CLOSED_CODE)
}
