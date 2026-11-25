// What google.status answers a caller: the owner sees every account; a bot (or a teammate reading as
// the shared bot) sees only its own.
import type { GoogleConnect } from '../../../google/google-connect'
import type { GoogleStatusView } from '../../../../shared/google/google-connect-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { botOfToken } from '../../../bots/bot-of-caller'
import { readGoogleDefaultAccount } from '../../../google/google-credential-store'
import {
  botGoogleAccess,
  botGoogleAccountFilter,
  botGoogleDefault,
  type BotGoogleAccess
} from '../../../../shared/google/google-bot-accounts'

async function statusView(
  runtime: OrcaRuntimeService,
  connect: GoogleConnect
): Promise<Omit<GoogleStatusView, 'accounts'>> {
  return {
    client: await connect.client(),
    bots: runtime.bots.enabled()
      ? runtime.bots
          .list()
          .filter((bot) => bot.google === true)
          .map((bot) => ({
            id: bot.id,
            name: bot.name,
            ...(bot.googleAccounts ? { accounts: bot.googleAccounts } : {})
          }))
      : []
  }
}

/** The account a bot's calls without --account use, read once from this computer's default. */
async function botDefaultAccount(access: BotGoogleAccess): Promise<string | null> {
  const read = botGoogleDefault(access, await readGoogleDefaultAccount())
  return 'email' in read ? read.email : null
}

/** The status `caller` may read: a bot without every account sees (and a check reads tokens of) only
 *  its own accounts, none while Google is off for it, and the default its own calls use; the owner
 *  sees them all. */
export async function readGoogleStatus(
  connect: GoogleConnect,
  { check }: { check?: boolean },
  runtime: OrcaRuntimeService,
  caller: ReturnType<typeof botOfToken>
): Promise<GoogleStatusView> {
  const access = caller.kind === 'bot' ? botGoogleAccess(caller.bot) : null
  const only = access ? botGoogleAccountFilter(access) : undefined
  const [accounts, clientKey] = check
    ? await Promise.all([connect.checkAccounts(only), connect.checkClient()])
    : [await connect.accounts(), await connect.clientCheck()]
  const defaultAccount =
    access && only ? await botDefaultAccount(access) : await connect.defaultAccount()
  return {
    ...(await statusView(runtime, connect)),
    accounts: only ? accounts.filter((account) => only(account.email)) : accounts,
    defaultAccount,
    ...(clientKey ? { clientKey } : {})
  }
}
