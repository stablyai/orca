import type { CliStatusCaller } from '../../../shared/orchestration/orchestration-caller-status'
import type { CliStatusResult } from '../../../shared/runtime-session-contracts'

export function formatCliStatus(status: CliStatusResult): string {
  return [
    ...(status.target && status.target.kind === 'environment'
      ? [`target: environment ${status.target.environment}`]
      : []),
    `appRunning: ${status.app.running}`,
    `pid: ${status.app.pid ?? 'none'}`,
    `desktopWindowStatus: ${status.app.desktopWindowStatus ?? 'unknown'}`,
    `runtimeState: ${status.runtime.state}`,
    `runtimeReachable: ${status.runtime.reachable}`,
    `runtimeConnectionState: ${status.runtime.connectionState ?? 'unknown'}`,
    `runtimeId: ${status.runtime.runtimeId ?? 'none'}`,
    `graphState: ${status.graph.state}`,
    ...(status.runtime.degradations ?? []).map((degradation) => `degraded: ${degradation.message}`),
    ...(status.caller === undefined ? [] : [`orcaSessionId: ${formatStatusCaller(status.caller)}`])
  ].join('\n')
}

function formatStatusCaller(caller: CliStatusCaller): string {
  if ('refusal' in caller) {
    return `none (refused: ${caller.refusal.code})`
  }
  return `${caller.orcaSessionId}${caller.live ? '' : ' (not live)'}`
}
