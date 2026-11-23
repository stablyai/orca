import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { botAccountSwitchBlocker } from '../bots/bot-account-switch-blocker'
import { OrcaAccountService } from '../orca-profiles/orca-account-service'
import { flushUnsavedCloudSessions } from '../orca-profiles/cloud-session/profile-cloud-session-owner'
import { installOrcaServerSignIn, OrcaServerSignIn } from '../orca-profiles/orca-server-sign-in'
import { GoogleConnect, installGoogleConnect } from '../google/google-connect'
import type { BotController } from '../bots/bot-controller'
import type { ConnectorCloud } from '../connector-cloud/connector-cloud'
import type { OrcadRelay } from './orcad-relay'
import type { BackendServiceCleanup } from '../backend/service-composition'
import { orcadServedProfileId } from './orcad-served-profile'
import type * as OrcadConnector from './orcad-connector'

/** The daemon's relay host and its Orca account, which signs the relay in and out. */
export async function installOrcadRelayAndAccount(
  runtime: Parameters<typeof installOrcadOrcaAccount>[0],
  registerCleanup: (cleanup: BackendServiceCleanup) => void
): Promise<OrcadRelay> {
  const { createOrcadRelay } = await import('./orcad-relay')
  const relay = createOrcadRelay(registerCleanup)
  installOrcadOrcaAccount(runtime, relay, registerCleanup)
  return relay
}

/** The daemon's connector host, loaded on first use like its relay. */
export async function installOrcadConnectorHost(
  ...args: Parameters<typeof OrcadConnector.installOrcadConnector>
): Promise<ReturnType<typeof OrcadConnector.installOrcadConnector>> {
  const { installOrcadConnector } = await import('./orcad-connector')
  return installOrcadConnector(...args)
}

/** orcad's Orca account: signed in only through a client that relays the code, never a browser here. */
export function installOrcadOrcaAccount(
  runtime: {
    bots: Pick<BotController, 'list'>
    serveOrcaProfile: (profileId: string) => void
    getConnectorCloud: () => Pick<
      ConnectorCloud,
      'accountChanged' | 'signOutStarted' | 'signOutFinished'
    > | null
  },
  relay: Pick<OrcadRelay, 'accountChanged' | 'signOutStarted'>,
  registerCleanup: (cleanup: BackendServiceCleanup) => void,
  /** The profile orcad serves, chosen at startup. */
  profileId = orcadServedProfileId()
): void {
  if (profileId) {
    runtime.serveOrcaProfile(profileId)
  }
  const account = new OrcaAccountService({
    openBrowser: async () => {
      throw new Error(
        'This server has no browser. Sign it in from a paired client or `orca auth login`.'
      )
    },
    accountBoundLinks: botAccountSwitchBlocker({
      bots: () => runtime.bots,
      profileId: () => profileId
    }),
    // A sign-out or switch on this server stops its relay and connector at once, as on the desktop.
    hooks: {
      onAuthMutation: () => {
        relay.accountChanged()
        runtime.getConnectorCloud()?.accountChanged()
      },
      onBeforeSignOut: () => {
        relay.signOutStarted()
        runtime.getConnectorCloud()?.signOutStarted()
      },
      onAfterSignOut: () => runtime.getConnectorCloud()?.signOutFinished()
    }
  })
  const server = new OrcaServerSignIn({ account })
  installOrcaServerSignIn(server)
  server.startDailyRefresh()
  // A rotation saved only in memory would be replayed after restart and end the session family.
  getAppEnvironment().onWillQuit(flushUnsavedCloudSessions)
  registerCleanup(() => installOrcaServerSignIn(null))
  // No browser here: Google sign-in prints its link and takes the pasted address, or a paired desktop's.
  installGoogleConnect(new GoogleConnect())
  registerCleanup(() => installGoogleConnect(null))
}
