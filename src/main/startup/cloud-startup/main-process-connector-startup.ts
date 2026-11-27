import { app, powerMonitor } from 'electron'
import { SharedBotHostStore } from '../../bots/shared-with-me/shared-bot-host-store'
import { keptSharedHostRegistry } from '../../bots/shared-with-me/shared-bot-host-key'
import { setSharedHosts } from '../../../shared/remote-runtime/pairing/shared-host-keys'
import { join } from 'node:path'
import type { ConnectorCloud } from '../../connector-cloud/connector-cloud'
import { installConnectorHost } from '../../connector-cloud/connector-host-install'
import { registerGoogleSetupHandlers } from '../../ipc/google-setup'
import { registerSlackHandOffHandlers } from '../../ipc/slack-hand-off'
import { registerSharedBotHostsHandlers } from '../../ipc/shared-bot-hosts'
import { registerAvatarGenerationHandlers } from '../../avatar-generation/avatar-generation-ipc'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import { installGoogleSetupHostWatch } from '../../google/google-setup-host-watch'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { mainProcessState as state } from '../main-process-state'
import type { SharedBotHosts } from '../../bots/shared-with-me/shared-bot-hosts'

let sharedBotHosts: SharedBotHosts | null = null

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
    // Its profile's kept shares, read only, so their mail is never taken for a share that ended.
    const kept = new SharedBotHostStore(userDataPath)
    const loaded = kept.load()
    setSharedHosts(
      keptSharedHostRegistry(
        kept,
        () => kept.list(),
        () => loaded
      )
    )
    return
  }
  powerMonitor.on('resume', host.refreshLinearLogins)
  registerGoogleSetupHandlers()
  registerSlackHandOffHandlers(() => runtime.getConnectorCloud())
  const store = state.store
  sharedBotHosts = registerSharedBotHostsHandlers({
    userDataPath,
    cloud: () => runtime.getConnectorCloud(),
    // Old homes go through the runtime's own delete, as a bot home's do.
    homes: {
      folderWorkspaceIds: () => store.getFolderWorkspaces().map((home) => home.id),
      deleteFolderWorkspace: (id) =>
        runtime.deleteFolderWorkspace(id, { discardUnsavedDrafts: true })
    },
    phoneSharesChanged: () => runtime.notifySharedBotsChanged()
  })
  powerMonitor.on('resume', refreshSharedBotHosts)
  // A share made while this window was in the background shows on return, not at the next idle read.
  let readOnFocusAt = 0
  app.on('browser-window-focus', () => {
    // The invite wake already said whether anything changed.
    if (mainProcessConnectorCloud()?.invites.up) {
      return
    }
    if (Date.now() - readOnFocusAt >= SHARED_BOT_HOSTS_FOCUS_READ_GAP_MS) {
      readOnFocusAt = Date.now()
      refreshSharedBotHosts()
    }
  })
  registerAvatarGenerationHandlers(() => runtime.getCommitMessageAgentEnvironmentResolvers())
}

// At most one focus read a minute: switching windows must not poll the cloud.
const SHARED_BOT_HOSTS_FOCUS_READ_GAP_MS = 60_000

/** Re-reads the agents shared with this account, as after a sign-in or a wake. */
export function refreshSharedBotHosts(): void {
  void sharedBotHosts?.refresh()
}

/** This process's connector, for the startup, auth and quit hooks. */
export function mainProcessConnectorCloud(): ConnectorCloud | null {
  return state.core.runtime?.getConnectorCloud() ?? null
}

/** Quit and relaunch: the relay host and the connector stop taking cloud work before teardown. */
export function fenceMainProcessCloudOnQuit(): void {
  state.core.relayHost?.fence()
  mainProcessConnectorCloud()?.fence()
  sharedBotHosts?.stop()
}

// Registered with the relay; like it, the first request waits for the persisted proxy.
export function connectMainProcessConnectorCloud(): void {
  void state.initialProxyApplicationReady.then(() => mainProcessConnectorCloud()?.connect())
}
