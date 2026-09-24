import type { CliStatusCaller } from '../shared/orchestration-caller-status'
import type { CliStatusResult } from '../shared/runtime-types'
import { prepareComputerCliJsonResult } from './computer-format'
import type { RuntimeRpcSuccess } from './runtime-client'

export { formatCliError, reportCliError, type CliErrorContext } from './cli-error'

export {
  formatBrowserProfileList,
  formatScreenshot,
  formatSnapshot,
  formatTabList,
  formatTabListWithProfiles,
  formatTabProfileClone,
  formatTabProfileShow,
  formatTabShow
} from './browser-format'

export {
  formatComputerAction,
  formatGetAppState,
  formatListApps,
  formatListWindows
} from './computer-format'
export type { ComputerActionFollowUpTarget } from './computer-format'
export {
  formatProjectHostSetupCreateResult,
  formatProjectHostSetupDeleteResult,
  formatProjectHostSetupList,
  formatProjectHostSetupResult,
  formatProjectHostSetupUpdateResult,
  formatProjectList
} from './project-format'
export {
  formatTerminalClose,
  formatTerminalCreate,
  formatTerminalFocus,
  formatTerminalList,
  formatTerminalRead,
  formatTerminalRename,
  formatTerminalSend,
  formatTerminalShow,
  formatTerminalSplit,
  formatTerminalWait,
  terminalSendWarnings
} from './terminal-format'
export {
  formatAutomationList,
  formatAutomationRemoved,
  formatAutomationRun,
  formatAutomationRuns,
  formatAutomationShow
} from './automation-format'
export type { AutomationListPayload, AutomationShowPayload } from './automation-format'
export {
  formatEnvironment,
  formatEnvironmentList,
  formatMemorySnapshot,
  formatRepoList,
  formatRepoRefs,
  formatRepoShow,
  formatWorktreeList,
  formatWorktreePs,
  formatWorktreeShow
} from './workspace-format'

export function printResult<TResult>(
  response: RuntimeRpcSuccess<TResult>,
  json: boolean,
  formatter: (value: TResult) => string
): void {
  if (json) {
    console.log(JSON.stringify(prepareComputerCliJsonResult(response), null, 2))
    return
  }
  console.log(formatter(response.result))
}

export type HostListEntry = {
  kind: 'local' | 'ssh' | 'environment'
  name: string
  id: string
  selector: string
  platform?: string
  machineName?: string
  connected?: boolean
  connectionStatus?: string
}

// Why: the selector column is the point of this command — the name alone is what callers already
// had, and passing it on the wrong axis is the mistake this output exists to prevent.
export function formatHostList(result: { hosts: HostListEntry[] }): string {
  const kindLabel: Record<HostListEntry['kind'], string> = {
    local: 'local',
    ssh: 'ssh target',
    environment: 'orca server'
  }
  return result.hosts
    .map(
      (host) =>
        `${kindLabel[host.kind].padEnd(11)} ${host.name}${host.machineName ? ` (${host.machineName})` : ''}  ${host.platform ?? 'platform unknown'}  ${formatHostConnection(host)}  ->  ${host.selector}`
    )
    .join('\n')
}

/** What one runtime calls itself; `machineName` is absent when the runtime predates the field. */
export type HostNameResult = {
  machineName?: string
  platform?: string
}

export function formatHostName(result: HostNameResult): string {
  return `${result.machineName ?? 'unknown'}${result.platform ? ` (${result.platform})` : ''}`
}

function formatHostConnection(host: HostListEntry): string {
  if (host.kind !== 'ssh') {
    return ''
  }
  if (host.connected === undefined) {
    return `connection unknown${host.connectionStatus ? ` (${host.connectionStatus})` : ''}`
  }
  return host.connected
    ? `connected${host.connectionStatus ? ` (${host.connectionStatus})` : ''}`
    : `not connected${host.connectionStatus ? ` (${host.connectionStatus})` : ''}`
}

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
    ...(status.caller === undefined ? [] : [`caller: ${formatStatusCaller(status.caller)}`])
  ].join('\n')
}

function formatStatusCaller(caller: CliStatusCaller): string {
  if (caller === null) {
    return 'none'
  }
  if ('refusal' in caller) {
    return `session:${caller.sessionId} (refused: ${caller.refusal.code})`
  }
  return `${caller.address}${caller.live ? '' : ' (not live)'}`
}

export function formatStatus(status: CliStatusResult): string {
  return formatCliStatus(status)
}
