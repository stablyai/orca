import { ipcMain } from 'electron'
import {
  BrowserClientHostPlacementPreparationRequest,
  type BrowserClientHostViewer,
  type BrowserPageCreationPlacement
} from '../../../../shared/browser/client-hosting/browser-client-host-placement'
import { pairedRuntimeBrowserClientHostViewer } from '../../../browser/client-hosts/lifecycle/paired-runtime-browser-client-host-viewers'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { prepareRuntimeEnvironmentBrowserPlacement } from './runtime-environment-browser-placement'

export function registerRuntimeEnvironmentBrowserClientHostHandler(options: {
  getUserDataPath: () => string
  getSettings: () => Pick<GlobalSettings, 'browserClientHostedRemoteEnabled'>
}): void {
  ipcMain.handle(
    'runtimeEnvironments:prepareBrowserClientHostPlacement',
    async (_event, input: unknown): Promise<BrowserPageCreationPlacement> => {
      const args = BrowserClientHostPlacementPreparationRequest.parse(input)
      const userDataPath = options.getUserDataPath()
      return prepareRuntimeEnvironmentBrowserPlacement(userDataPath, {
        ...args,
        enabled: options.getSettings().browserClientHostedRemoteEnabled !== false
      })
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:browserClientHostViewer',
    (_event, environmentId: unknown): BrowserClientHostViewer | null =>
      typeof environmentId === 'string' ? pairedRuntimeBrowserClientHostViewer(environmentId) : null
  )
}
