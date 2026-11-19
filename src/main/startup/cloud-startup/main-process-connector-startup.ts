import { powerMonitor } from 'electron'
import type { ConnectorCloud } from '../../connector-cloud/connector-cloud'
import { installConnectorHost } from '../../connector-cloud/connector-host-install'
import { registerGoogleSetupHandlers } from '../../ipc/google-setup'
import { registerSlackHandOffHandlers } from '../../ipc/slack-hand-off'
import { registerAvatarGenerationHandlers } from '../../avatar-generation/avatar-generation-ipc'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import { getGoogleConnect } from '../../google/google-connect'
import {
  googleSetupKeyDownloadClaim,
  googleSetupWithholdsPageText
} from '../../google/google-setup-key-download'
import { googleSetupRuns } from '../../google/google-setup-runs'
import { setPageTextWithheld } from '../../browser/agent-browser/agent-browser-withheld-page-text'
import {
  answerGoogleSetupCard,
  recordGoogleSetupKeyMissed
} from '../../runtime/rpc/methods/bots-google-setup'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { mainProcessState as state } from '../main-process-state'

/**
 * The desktop's or Electron `orca serve`'s connector, as this process's own Orca account.
 * Created before the window exists, so its sign-in and sign-out hooks always find it.
 */
export function installMainProcessConnectorCloud(serve: boolean): void {
  if (!state.runtime || !state.store) {
    return
  }
  const runtime = state.runtime
  const userDataPath = getProfileUserDataPath()
  const host = installConnectorHost({
    runtime,
    store: state.store,
    userDataPath,
    kind: serve ? 'serve' : 'desktop',
    isFenced: () => state.isQuitting
  })
  if (serve) {
    return
  }
  powerMonitor.on('resume', host.refreshLinearLogins)
  registerGoogleSetupHandlers()
  registerSlackHandOffHandlers(() => runtime.getConnectorCloud())
  registerAvatarGenerationHandlers(() => runtime.getCommitMessageAgentEnvironmentResolvers())
  browserManager.setStandingDownloadClaim(
    googleSetupKeyDownloadClaim({
      runs: () => googleSetupRuns().list(),
      importKey: (text) => {
        const connect = getGoogleConnect()
        if (!connect) {
          throw new Error("Google isn't available on this computer.")
        }
        connect.importClient(text)
      },
      keyArrived: (botId) =>
        answerGoogleSetupCard(runtime, botId, 'owner', 'step', ['done', 'client']),
      keyRefused: (botId, reason) => recordGoogleSetupKeyMissed(runtime, botId, reason)
    })
  )
  // The Create dialog shows the client secret: no click's effects may read that page back.
  setPageTextWithheld((page) => googleSetupWithholdsPageText(googleSetupRuns().list(), page))
}

/** This process's connector, for the startup, auth and quit hooks. */
export function mainProcessConnectorCloud(): ConnectorCloud | null {
  return state.runtime?.getConnectorCloud() ?? null
}

/** Quit and relaunch: the relay host and the connector stop taking cloud work before teardown. */
export function fenceMainProcessCloudOnQuit(): void {
  state.relayHost?.fence()
  mainProcessConnectorCloud()?.fence()
}

// Registered with the relay; like it, the first request waits for the persisted proxy.
export function connectMainProcessConnectorCloud(): void {
  void state.initialProxyApplicationReady.then(() => mainProcessConnectorCloud()?.connect())
}
