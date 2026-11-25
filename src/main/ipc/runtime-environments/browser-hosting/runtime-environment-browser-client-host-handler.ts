import { handleRuntimeEnvironmentChannel } from '../runtime-environment-channel-handling'
import {
  BrowserClientHostPlacementPreparationRequest,
  type BrowserPageCreationPlacement
} from '../../../../shared/browser/client-hosting/browser-client-host-placement'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { prepareRuntimeEnvironmentBrowserPlacement } from './runtime-environment-browser-placement'

export function registerRuntimeEnvironmentBrowserClientHostHandler(options: {
  getUserDataPath: () => string
  getSettings: () => Pick<GlobalSettings, 'browserClientHostedRemoteEnabled'>
}): void {
  handleRuntimeEnvironmentChannel(
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
}
