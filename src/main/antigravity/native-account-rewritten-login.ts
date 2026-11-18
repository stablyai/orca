import type {
  AntigravityCredentialIdentity,
  AntigravityNativeCredential
} from './native-credential-codec'
import type { StoredAntigravityAccount } from './native-account-store'

type LookupIdentity = (accessToken: string) => Promise<AntigravityCredentialIdentity>

/** agy can rewrite its login with a new refresh token and no id_token (e.g. after a long run), so
 *  no saved snapshot matches it; Google's userinfo names the account so the snapshot can follow. */
export class AntigravityRewrittenLoginIdentity {
  // One lookup per access token, so repeated reads of an unsaved login stay offline.
  private last: {
    accessToken: string
    identity: Promise<AntigravityCredentialIdentity | null>
  } | null = null

  constructor(private readonly lookup: () => LookupIdentity) {}

  async identify(
    current: AntigravityNativeCredential | null,
    accounts: readonly StoredAntigravityAccount[],
    matches: (account: StoredAntigravityAccount, current: AntigravityNativeCredential) => boolean
  ): Promise<AntigravityNativeCredential | null> {
    if (
      !current ||
      current.identity ||
      !accounts.some((account) => account.subject) ||
      accounts.some((account) => matches(account, current))
    ) {
      return current
    }
    if (this.last?.accessToken !== current.accessToken) {
      this.last = {
        accessToken: current.accessToken,
        identity: this.lookup()(current.accessToken).catch(() => null)
      }
    }
    const identity = await this.last.identity
    return identity ? { ...current, identity } : current
  }
}
