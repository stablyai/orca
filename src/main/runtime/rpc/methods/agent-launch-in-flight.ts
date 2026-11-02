import type { AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { AgentLaunchAdmission } from './agent-launch-replay'

export type ActiveAgentLaunch = {
  fingerprint: string
  promise: Promise<AgentLaunchResult>
  /** Its admission, shared with every request that joins it; null when the launch failed before one. */
  admitted: Promise<AgentLaunchAdmission | null>
}

const activeAgentLaunchesByRuntime = new WeakMap<
  OrcaRuntimeService,
  Map<string, ActiveAgentLaunch>
>()

export function activeAgentLaunchesFor(
  runtime: OrcaRuntimeService
): Map<string, ActiveAgentLaunch> {
  let active = activeAgentLaunchesByRuntime.get(runtime)
  if (!active) {
    active = new Map()
    activeAgentLaunchesByRuntime.set(runtime, active)
  }
  return active
}

/** The caller operation's running launch, or `start`'s, registered before any await so that every
 *  overlapping request joins one execution and one admission; another request under the id conflicts. */
export function joinOrStartActiveAgentLaunch(
  runtime: OrcaRuntimeService,
  key: string,
  fingerprint: string,
  start: (onAdmitted: (admission: AgentLaunchAdmission) => void) => Promise<AgentLaunchResult>
): ActiveAgentLaunch {
  const activeAgentLaunches = activeAgentLaunchesFor(runtime)
  const active = activeAgentLaunches.get(key)
  if (active) {
    if (active.fingerprint !== fingerprint) {
      throw new Error('agent_session_operation_conflict')
    }
    return active
  }
  const admitted = Promise.withResolvers<AgentLaunchAdmission | null>()
  let promise: Promise<AgentLaunchResult>
  promise = start(admitted.resolve).finally(() => {
    admitted.resolve(null)
    if (activeAgentLaunches.get(key)?.promise === promise) {
      activeAgentLaunches.delete(key)
    }
  })
  const launch = { fingerprint, promise, admitted: admitted.promise }
  activeAgentLaunches.set(key, launch)
  return launch
}
