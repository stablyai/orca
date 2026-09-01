// The resolve -> spawn -> settle sequencer every host launch surface shares (U3).
// A surface supplies the resolution inputs plus a `spawn` executor that creates
// and registers exactly ONE PTY from the resolved plan; this module runs the
// resolution through the host boundary, invokes the executor only on success, and
// settles the admission reservation ('registered' once the PTY is registered,
// 'failed' if the executor throws). A typed resolution failure/request error
// returns without ever calling the executor, so no PTY is created. Client-supplied
// command/env/launchConfig are irrelevant here: the plan comes only from
// resolveAgentLaunchSpawn's host resolution.

import type { AgentStartupPlan } from '../../shared/tui-agent-startup'
import type {
  AgentLaunchFailure,
  AgentLaunchReceipt,
  AgentLaunchRequestError
} from '../../shared/agent-launch-contract'
import {
  resolveAgentLaunchSpawn,
  type AgentLaunchSpawnDeps,
  type AgentLaunchSpawnInput
} from './agent-launch-spawn'

/** Creates and registers exactly one PTY from the resolved plan. Must throw on
 *  spawn/registration failure so the reservation settles 'failed'; a returned
 *  value means the PTY is registered. */
export type LaunchSpawnExecutor<R> = (plan: AgentStartupPlan, launchToken: string) => Promise<R>

export type DispatchAgentLaunchArgs<R> = {
  deps: AgentLaunchSpawnDeps
  input: AgentLaunchSpawnInput
  spawn: LaunchSpawnExecutor<R>
}

export type DispatchAgentLaunchResult<R> =
  | { ok: true; result: R; receipt: AgentLaunchReceipt }
  | { ok: false; failure: AgentLaunchFailure }
  | { ok: false; requestError: AgentLaunchRequestError }

/** Resolve, then spawn+settle exactly once. Rethrows an executor failure after
 *  settling 'failed' so the caller's existing spawn-error handling still runs. */
export async function dispatchAgentLaunchSpawn<R>(
  args: DispatchAgentLaunchArgs<R>
): Promise<DispatchAgentLaunchResult<R>> {
  const resolution = await resolveAgentLaunchSpawn(args.deps, args.input)
  if (!resolution.ok) {
    return resolution
  }
  const { plan, receipt } = resolution
  try {
    const result = await args.spawn(plan, receipt.launchToken)
    args.deps.boundary.settleAgentLaunch(receipt.launchToken, 'registered')
    return { ok: true, result, receipt }
  } catch (err) {
    args.deps.boundary.settleAgentLaunch(receipt.launchToken, 'failed')
    throw err
  }
}
