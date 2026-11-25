import { app, type MessagePortMain, type UtilityProcess } from 'electron'
import { readDesktopOwnerIdentity } from '../backend/backend-desktop-owner-watch'
import {
  BACKEND_CAPABILITIES,
  type BackendBootstrap
} from '../../shared/backend/backend-service-contract'

export let capturedBootstrap: BackendBootstrap | undefined

/** Capture at the same pre-name-change phase as the former usage path initializers. */
export function captureBackendBootstrap(): void {
  capturedBootstrap = {
    protocol: 1,
    requiredCapabilities: [...BACKEND_CAPABILITIES],
    services: ['usage'],
    build: app.getVersion(),
    paths: {
      userData: app.getPath('userData')
    },
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged
  }
}

/** Carries main's identity, so the backend can tell main's death from a reused pid. */
export function sendBackendBootstrap(
  child: UtilityProcess,
  port: MessagePortMain,
  isCurrent: () => boolean
): void {
  void readDesktopOwnerIdentity().then((desktopOwner) => {
    if (!isCurrent()) {
      port.close()
      return
    }
    child.postMessage(
      { type: 'bootstrap', config: capturedBootstrap && { ...capturedBootstrap, desktopOwner } },
      [port]
    )
  })
}
