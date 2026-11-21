import { OrcaAccountService } from '../orca-profiles/orca-account-service'
import { botAccountSwitchBlocker } from '../bots/bot-account-switch-blocker'
import { mainProcessConnectorCloud } from './cloud-startup/main-process-connector-startup'
import { mainProcessState as state } from './main-process-state'
import { redeclarePairedDesktopAccounts } from '../ipc/runtime-environments/connections/runtime-environment-request-connections'

export function createDesktopOrcaAccountService(
  openBrowser: (url: string) => Promise<void>
): OrcaAccountService {
  return new OrcaAccountService({
    openBrowser,
    accountBoundLinks: botAccountSwitchBlocker({
      bots: () => state.core.runtime?.bots ?? null,
      profileId: () => state.activeOrcaProfile?.profile.id ?? null
    }),
    hooks: {
      onAuthMutation: () => {
        // An auth change retries relay installation after launch-time failure.
        state.core.relayHost?.accountChanged()
        mainProcessConnectorCloud()?.accountChanged()
        redeclarePairedDesktopAccounts()
      },
      // Only sign-out fences paired phones; reasonless quit/relaunch must not look like logout.
      onBeforeSignOut: () => {
        state.core.relayHost?.signOutStarted()
        mainProcessConnectorCloud()?.signOutStarted()
      },
      onAfterSignOut: () => {
        mainProcessConnectorCloud()?.signOutFinished()
        redeclarePairedDesktopAccounts()
      }
    }
  })
}
