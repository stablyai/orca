import type { CliStatusCaller } from '../shared/orchestration/orchestration-caller-status'
import type { CliStatusResult } from '../shared/runtime-types'
import { formatBrowserActionEffects } from './browser/browser-format'
import { prepareComputerCliJsonResult } from './computer-format'
import type { RuntimeRpcSuccess } from './runtime-client'

export { formatCliError, reportCliError, type CliErrorContext } from './cli-error'

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
  formatTerminalSetPaneTitle,
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
  formatAutomationRunsPage,
  formatAutomationShow
} from './automation-format'
export type { AutomationListPayload, AutomationShowPayload } from './automation-format'
export {
  formatSavedServer,
  formatSavedServerList,
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
  console.log(formatter(response.result) + formatBrowserActionEffects(response.result))
}

export type HostListEntry = {
  kind: 'local' | 'ssh' | 'server'
  name: string
  id: string
  selector: string
  platform?: string
  machineName?: string
  connected?: boolean
  connectionStatus?: string
}

// Explicit host selectors prevent callers from using a display name on the wrong host scope.
export function formatHostList(result: { hosts: HostListEntry[] }): string {
  const kindLabel: Record<HostListEntry['kind'], string> = {
    local: 'local',
    ssh: 'ssh target',
    server: 'orca server'
  }
  return result.hosts
    .map(
      (host) =>
        `${kindLabel[host.kind].padEnd(11)} ${host.name}${host.machineName ? ` (${host.machineName})` : ''}  ${host.platform ?? 'platform unknown'}  ${formatHostConnection(host)}  ->  ${host.selector}`
    )
    .join('\n')
}

/** What one server calls itself; `machineName` is absent when the server predates the field. */
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
    ...(status.target ? [`server: ${formatStatusTarget(status.target)}`] : []),
    `appRunning: ${status.app.running}`,
    `pid: ${status.app.pid ?? 'none'}`,
    `desktopWindowStatus: ${status.app.desktopWindowStatus ?? 'unknown'}`,
    `state: ${status.runtime.state}`,
    `reachable: ${status.runtime.reachable}`,
    `connection: ${status.runtime.connectionState ?? 'unknown'}`,
    `instance: ${status.runtime.runtimeId ?? 'none'}`,
    `graphState: ${status.graph.state}`,
    ...(status.runtime.degradations ?? []).map((degradation) => `degraded: ${degradation.message}`),
    ...(status.caller === undefined ? [] : [`orcaSessionId: ${formatStatusCaller(status.caller)}`])
  ].join('\n')
}

function formatStatusTarget(target: NonNullable<CliStatusResult['target']>): string {
  if (target.kind === 'local') {
    return 'local'
  }
  return target.server === 'pairing-code' ? 'one-off connection' : target.server
}

function formatStatusCaller(caller: CliStatusCaller): string {
  if ('refusal' in caller) {
    return `none (refused: ${caller.refusal.code})`
  }
  return `${caller.orcaSessionId}${caller.live ? '' : ' (not live)'}`
}

export function formatStatus(status: CliStatusResult): string {
  return formatCliStatus(status)
}
