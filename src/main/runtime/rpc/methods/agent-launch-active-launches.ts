/**
 * Replay-safe launches still running in this process, so a retry under the same operation joins the
 * one already running instead of starting a second.
 */

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
  const existing = activeAgentLaunchesByRuntime.get(runtime)
  if (existing) {
    return existing
  }
  const active = new Map<string, ActiveAgentLaunch>()
  activeAgentLaunchesByRuntime.set(runtime, active)
  return active
}
