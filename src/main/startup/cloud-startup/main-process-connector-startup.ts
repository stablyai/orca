import { ipcMain, powerMonitor } from 'electron'
import { join } from 'node:path'
import type { ConnectorCloud } from '../../connector-cloud/connector-cloud'
import { installConnectorHost } from '../../connector-cloud/connector-host-install'
import { registerLazyIpcHandleGroup } from '../../ipc/lazy-ipc-handle-group'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import { installGoogleSetupHostWatch } from '../../google/google-setup-host-watch'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { mainProcessState as state } from '../main-process-state'

/**
 * The desktop's or Electron `orca serve`'s connector, as this process's own Orca account.
 * Created before the window exists, so its sign-in and sign-out hooks always find it.
 */
export function installMainProcessConnectorCloud(serve: boolean): void {
  if (!state.core.runtime || !state.store) {
    return
  }
  const runtime = state.core.runtime
  const userDataPath = getProfileUserDataPath()
  const host = installConnectorHost({
    runtime,
    store: state.store,
    userDataPath,
    kind: serve ? 'serve' : 'desktop',
    isFenced: () => state.isQuitting
  })
  // `orca serve` runs agents too, with its own offscreen browser or a paired desktop's.
  installGoogleSetupHostWatch(runtime, {
    setStandingDownloadClaim: (resolver) => browserManager.setStandingDownloadClaim(resolver),
    getWorktreeIdForTab: (id) => browserManager.getWorktreeIdForTab(id),
    keyStagingDir: join(userDataPath, 'google-setup-keys')
  })
  if (serve) {
    return
  }
  powerMonitor.on('resume', host.refreshLinearLogins)
  const googleSetupChannels = [
    'googleSetup:pickClientFile',
    'googleSetup:saveAppFile',
    'googleSetup:watchDownloads',
    'googleSetup:stopWatchingDownloads',
    'googleSetup:findDownloadedKey'
  ] as const
  for (const channel of googleSetupChannels) {
    ipcMain.removeHandler(channel)
  }
  registerLazyIpcHandleGroup(googleSetupChannels, async (ipc) => {
    const { registerGoogleSetupHandlers } = await import('../../ipc/google-setup')
    registerGoogleSetupHandlers(ipc)
  })
  ipcMain.removeHandler('slackHandOff:redeem')
  registerLazyIpcHandleGroup(['slackHandOff:redeem'], async (ipc) => {
    const { registerSlackHandOffHandlers } = await import('../../ipc/slack-hand-off')
    registerSlackHandOffHandlers(() => runtime.getConnectorCloud(), ipc)
  })
  const avatarGenerationChannels = [
    'avatarGeneration:capability',
    'avatarGeneration:generate',
    'avatarGeneration:cancel'
  ] as const
  for (const channel of avatarGenerationChannels) {
    ipcMain.removeHandler(channel)
  }
  registerLazyIpcHandleGroup(avatarGenerationChannels, async (ipc) => {
    const { registerAvatarGenerationHandlers } =
      await import('../../avatar-generation/avatar-generation-ipc')
    registerAvatarGenerationHandlers(() => runtime.getCommitMessageAgentEnvironmentResolvers(), ipc)
  })
}

/** This process's connector, for the startup, auth and quit hooks. */
export function mainProcessConnectorCloud(): ConnectorCloud | null {
  return state.core.runtime?.getConnectorCloud() ?? null
}

/** Quit and relaunch: the relay host and the connector stop taking cloud work before teardown. */
export function fenceMainProcessCloudOnQuit(): void {
  state.core.relayHost?.fence()
  mainProcessConnectorCloud()?.fence()
}

// Registered with the relay; like it, the first request waits for the persisted proxy.
export function connectMainProcessConnectorCloud(): void {
  void state.initialProxyApplicationReady.then(() => mainProcessConnectorCloud()?.connect())
}
