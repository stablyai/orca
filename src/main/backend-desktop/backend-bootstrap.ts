import { app } from 'electron'
import { BACKEND_CAPABILITIES, type BackendBootstrap } from '../../shared/backend-service-contract'

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
