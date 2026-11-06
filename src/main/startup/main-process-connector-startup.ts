import type { ConnectorCloud } from '../connector-cloud/connector-cloud'
import { createDesktopConnectorCloud } from '../connector-cloud/connector-cloud-install'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { mainProcessState as state } from './main-process-state'

// Desktop only: the connector acts as the signed-in Orca account, which `orca serve` does not have yet.
// Created before the window exists, so its sign-in and sign-out hooks always find it.
export function installDesktopConnectorCloud(): void {
  if (!state.runtime || !state.store) {
    return
  }
  state.runtime.setConnectorCloud(
    createDesktopConnectorCloud(
      state.runtime,
      state.store,
      getProfileUserDataPath(),
      () => state.isQuitting
    )
  )
}

/** The desktop's connector, for the startup, auth and quit hooks. */
export function desktopConnectorCloud(): ConnectorCloud | null {
  return state.runtime?.getConnectorCloud() ?? null
}

// Registered with the relay; like it, the first request waits for the persisted proxy.
export function connectDesktopConnectorCloud(): void {
  void state.initialProxyApplicationReady.then(() => desktopConnectorCloud()?.connect())
}
