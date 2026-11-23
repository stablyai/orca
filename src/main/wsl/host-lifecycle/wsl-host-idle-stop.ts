/**
 * WSL hosts whose orcad told this desktop it stopped idle (#46567). Until the user needs the host
 * again, nothing relaunches it: liveness reports it idle, its control socket holds its reconnect,
 * and background calls are refused, so its distro may stop. A user's call wakes it, booting the
 * distro if it stopped; unlike a stop the user made, that never leaves the panes on Start.
 */
import { clearRuntimeEnvironmentContactLoss } from '../../ipc/runtime-environments/status/runtime-environment-contact-loss'
import type { WslOrcadConnectionStatus } from '../orcad/wsl-orcad-connection-status'
import type { WslOrcadConnection } from '../orcad/wsl-orcad-connection-types'
import { defaultWslOrcadEnvironmentId } from '../orcad/wsl-orcad-environment-id'

const idleStopped = new Set<string>()

/** The host's own close said idle stop; that close was an answer, so it is no lost contact. */
export function noteWslHostIdleStop(environmentId: string): void {
  idleStopped.add(environmentId)
  clearRuntimeEnvironmentContactLoss(environmentId)
}

export function isWslHostIdleStopped(environmentId: string): boolean {
  return idleStopped.has(environmentId)
}

/** A wake, or a server answering again: its next stop must again prove it was idle. */
export function clearWslHostIdleStop(environmentId: string): void {
  idleStopped.delete(environmentId)
}

/**
 * What a connection change means for an idle-stopped host: any ready server (a user's Start, a
 * due automation, a wake) ends the idle stop, and the distro stopping after it is that idle stop's
 * doing, not a stop that parks the host and offers Start.
 */
export function withWslHostIdleStop(
  distro: string,
  connection: WslOrcadConnection | null,
  status: WslOrcadConnectionStatus
): WslOrcadConnectionStatus {
  const environmentId = connection?.environmentId ?? defaultWslOrcadEnvironmentId(distro)
  if (status.state === 'ready') {
    clearWslHostIdleStop(environmentId)
  }
  return status.state === 'distro-stopped' && isWslHostIdleStopped(environmentId)
    ? { state: 'idle', terminals: 'unverifiable' }
    : status
}
