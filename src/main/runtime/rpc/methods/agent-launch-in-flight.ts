import type { AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import type { OrcaRuntimeService } from '../../orca-runtime'

type ActiveAgentLaunch = {
  fingerprint: string
  promise: Promise<AgentLaunchResult>
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
