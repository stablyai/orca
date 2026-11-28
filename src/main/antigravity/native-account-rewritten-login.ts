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

  constructor(
    private readonly lookup: () => LookupIdentity,
    private readonly now: () => number = Date.now
  ) {}

  async identify(
    current: AntigravityNativeCredential | null,
    accounts: readonly StoredAntigravityAccount[],
    matches: (account: StoredAntigravityAccount, current: AntigravityNativeCredential) => boolean
  ): Promise<AntigravityNativeCredential | null> {
    if (
      !current ||
      current.identity ||
      !accounts.some((account) => account.subject) ||
      // Google rejects an expired access token; agy refreshes it on its next run.
      (current.accessTokenExpiresAt !== null && current.accessTokenExpiresAt <= this.now()) ||
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

/** Who a login being saved belongs to. `keepUnidentified` saves it without one when Google can't
 *  say, and doesn't ask at all once its access token expired, since Google rejects that token. */
export async function identifyLoginToSave(
  current: AntigravityNativeCredential,
  lookup: LookupIdentity,
  now: number,
  options?: { keepUnidentified?: boolean }
): Promise<AntigravityCredentialIdentity | null> {
  if (current.identity) {
    return current.identity
  }
  const keep = options?.keepUnidentified === true
  if (keep && current.accessTokenExpiresAt !== null && current.accessTokenExpiresAt <= now) {
    return null
  }
  return lookup(current.accessToken).catch((error: unknown) => {
    if (keep) {
      return null
    }
    throw error
  })
}
