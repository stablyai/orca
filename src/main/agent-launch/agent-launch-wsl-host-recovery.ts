/** What a chat refused in a Windows-opened WSL folder can do instead: run it on a WSL host. */

import { wslHostMovableDistroOfPath } from '../../shared/file-access/wsl-paths'
import { wslHostsAcceptNewWork } from '../wsl/host-lifecycle/wsl-host-gate'
import { getWslHostService } from '../wsl/host-lifecycle/wsl-host-service-instance'
import { AgentLaunchSurfaceUnavailableError } from './agent-launch-surface-refusal'

export type WslHostChatFacts = { settingOn: boolean; hostAdded: boolean }

export type WslHostChatRecovery = { wslDistro: string; nextSteps: string[] }

/** Read only to word a WSL refusal's next steps. */
export type WslHostChatSettingsSource = { requireStore?: () => { getSettings(): object | null } }

function readWslHostsSettingOn(source: WslHostChatSettingsSource): boolean {
  try {
    const settings = source.requireStore?.().getSettings()
    return (
      !!settings && 'experimentalWslHosts' in settings && settings.experimentalWslHosts === true
    )
  } catch {
    return false
  }
}

/** Null where this launch can't add WSL hosts, which the renderer's offer also requires. */
function wslHostChatFactsReader(
  settingOn: () => boolean
): (distro: string) => Promise<WslHostChatFacts | null> {
  return async (distro) => {
    const service = getWslHostService()
    if (!service || !wslHostsAcceptNewWork() || !service.hasServerFiles()) {
      return null
    }
    return { settingOn: settingOn(), hostAdded: await service.isKnownDistro(distro) }
  }
}

/** Null for a Windows drive reached through the distro, or while WSL hosts can't be added. */
export async function wslHostChatRecovery(
  workspacePath: string | undefined,
  readFacts: (distro: string) => Promise<WslHostChatFacts | null>
): Promise<WslHostChatRecovery | null> {
  const distro = workspacePath ? wslHostMovableDistroOfPath(workspacePath) : null
  const facts = distro ? await readFacts(distro) : null
  if (!distro || !facts) {
    return null
  }
  const move = `choose “Move to ${distro} host…” on the project in the sidebar, then launch the chat there.`
  const setup = [
    ...(facts.settingOn ? [] : ['turn on Settings → Experimental → WSL hosts']),
    ...(facts.hostAdded
      ? []
      : [`add ${distro} as a host (Add a project → Add remote host → Add WSL distro)`])
  ]
  return {
    wslDistro: distro,
    nextSteps: [
      `Chat works when the project runs on the ${distro} WSL host. In Orca, ${[...setup, move].join(', then ')}`,
      'Or run the same command with --surface terminal to start the agent in a terminal.'
    ]
  }
}

/** Adds the WSL host path to a WSL refusal; any other error passes through unchanged. */
export async function withWslHostChatRecovery(
  error: unknown,
  workspacePath: string | undefined,
  settings: WslHostChatSettingsSource
): Promise<unknown> {
  if (
    !(error instanceof AgentLaunchSurfaceUnavailableError) ||
    error.reason !== 'wsl_execution_runtime'
  ) {
    return error
  }
  const recovery = await wslHostChatRecovery(
    workspacePath,
    wslHostChatFactsReader(() => readWslHostsSettingOn(settings))
  ).catch(() => null)
  return recovery
    ? new AgentLaunchSurfaceUnavailableError(error.message, error.reason, recovery)
    : error
}
