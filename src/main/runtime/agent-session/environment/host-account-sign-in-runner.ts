import type {
  HostAccountSignInChannel,
  HostAccountSignInProvider,
  HostAccountSignInStatus
} from '../../../../shared/host-account-sign-in-types'
import type { RuntimeAccountServices } from './runtime-account-controller'

/** Adds a host account whose login a client on another device finishes. */
export async function runHostAccountSignIn(
  { claudeAccounts, codexAccounts }: RuntimeAccountServices,
  provider: HostAccountSignInProvider,
  channel: HostAccountSignInChannel
): Promise<Pick<HostAccountSignInStatus, 'claude' | 'codex'>> {
  return provider === 'claude'
    ? { claude: await claudeAccounts.addAccountWithPastedCode(channel) }
    : { codex: await codexAccounts.addAccountWithDeviceCode(channel) }
}

/** CODEX_HOME of the selected host Orca account that launches here use; null when none. */
export function hostCodexLaunchHome(services: RuntimeAccountServices | null): string | null {
  return services?.codexAccounts.runtimeHomeService.getSelectedHostAccountCodexHomePath() ?? null
}
