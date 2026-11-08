import {
  getSystemMonitorProbeBinaries,
  resolveDetectedSystemMonitorIds,
  type SystemMonitorId
} from '../../shared/system-monitors'
import { hydrateShellPathForAgentDetection } from '../ipc/command-path/agent-detection-shell-path'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight-runtime-target'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { detectAgentCommandsOnHost } from './agent-command-detection'
import type { AgentDetectionHost } from './workspace-agent-detection'

export async function detectInstalledSystemMonitors(
  context?: PreflightRuntimeContext
): Promise<SystemMonitorId[]> {
  const runtime = getPreflightWslTarget(context) ? 'wsl' : process.platform
  const probeBinaries = getSystemMonitorProbeBinaries(runtime)
  const foundBinaries = await detectAgentCommandsOnHost(probeBinaries, { context })
  return resolveDetectedSystemMonitorIds(foundBinaries, runtime)
}

export async function detectSystemMonitorsOnHost(
  host: AgentDetectionHost
): Promise<SystemMonitorId[]> {
  if (host.kind === 'ssh') {
    throw new SshHostNotServedError(host.connectionId)
  }
  await hydrateShellPathForAgentDetection(host.context)
  return detectInstalledSystemMonitors(host.context)
}
