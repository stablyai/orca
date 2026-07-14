import {
  browserUserDataDir,
  nativeMessagingManifestPath,
  windowsRegistryHostKey
} from '../../cli/chat-import-host/native-messaging-host-paths'
import type { InstallBrowser } from '../../cli/chat-import-host/install-native-messaging-host'

// Why: pure detection so the settings pane (and its tests) never touch the
// real filesystem/registry — callers inject `exists`/`registryHas`.
export function detectBrowserSetup(a: {
  browser: InstallBrowser
  platform: NodeJS.Platform
  homeDir: string
  userDataPath: string
  exists: (p: string) => boolean
  registryHas: (registryKey: string) => boolean
}): { detected: boolean; hostInstalled: boolean } {
  const detected = a.exists(
    browserUserDataDir({ browser: a.browser, platform: a.platform, homeDir: a.homeDir })
  )
  const hostInstalled =
    a.platform === 'win32'
      ? a.registryHas(windowsRegistryHostKey(a.browser))
      : a.exists(
          nativeMessagingManifestPath({
            browser: a.browser,
            platform: a.platform,
            homeDir: a.homeDir,
            userDataPath: a.userDataPath
          })
        )
  return { detected, hostInstalled }
}
