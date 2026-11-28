import type { AntigravityAccountState } from '../../shared/agent-accounts/antigravity/antigravity-account-types'
import type { AntigravityNativeCredential } from './native-credential-codec'
import type {
  AntigravityAccountStore,
  AntigravityAccountVault,
  StoredAntigravityAccount,
  VerifiedAntigravityLogin
} from './native-account-store'

/** A keychain item's `fingerprint`, which changes whenever its login is rewritten, or the login
 *  itself where it is stored somewhere reading it raises no dialog. */
export type AntigravityQuietRead =
  | { fingerprint: string }
  | { credential: AntigravityNativeCredential | null }

export type AntigravityLoginView = Omit<VerifiedAntigravityLogin, 'fingerprint'>

type LoginBackend = {
  read(): Promise<AntigravityNativeCredential | null>
  readWithoutPrompt?(): Promise<AntigravityQuietRead>
}

/** Reads agy's login and remembers, by its keychain item's fingerprint, which account the last read
 *  found, so a listing can name it without the read and the keychain dialog it may raise. */
export class AntigravityLoginReader {
  // The latest login read under a fingerprint that held still across the read, until a listing
  // keeps it in the vault.
  private lastRead: { fingerprint: string; current: AntigravityNativeCredential } | null = null

  constructor(
    private readonly backend: LoginBackend,
    private readonly store: AntigravityAccountStore,
    private readonly matches: (
      account: StoredAntigravityAccount,
      current: AntigravityNativeCredential
    ) => boolean
  ) {}

  /** `quiet`: what the caller already read without a prompt. `fingerprint`: the keychain item's,
   *  when it held still across the read, so the login read is the one it names. */
  async read(quiet?: AntigravityQuietRead): Promise<{
    current: AntigravityNativeCredential | null
    fingerprint: string | null
  }> {
    // A failed quiet read leaves the read itself to answer, as before quiet reads existed.
    const quietRead = () => this.backend.readWithoutPrompt?.().catch(() => undefined)
    const before = quiet ?? (await quietRead())
    if (before && 'credential' in before) {
      return { current: before.credential, fingerprint: null }
    }
    const current = await this.backend.read()
    const after = before ? await quietRead() : undefined
    return {
      current,
      fingerprint:
        before && after && 'fingerprint' in after && after.fingerprint === before.fingerprint
          ? before.fingerprint
          : null
    }
  }

  note(fingerprint: string | null, current: AntigravityNativeCredential | null): void {
    if (fingerprint && current) {
      this.lastRead = { fingerprint, current }
    }
  }

  /** The login last read while agy's keychain item still has `fingerprint`, kept in the vault so it
   *  outlives a restart; null when agy rewrote its login since. */
  async known(
    vault: AntigravityAccountVault,
    fingerprint: string
  ): Promise<AntigravityLoginView | null> {
    if (this.lastRead?.fingerprint !== fingerprint) {
      return vault.verifiedLogin?.fingerprint === fingerprint ? vault.verifiedLogin : null
    }
    const next = this.view(vault, this.lastRead.current)
    this.lastRead = null
    const cached = vault.verifiedLogin
    if (
      cached?.fingerprint !== fingerprint ||
      cached.email !== next.email ||
      cached.subject !== next.subject ||
      cached.authMethod !== next.authMethod ||
      cached.accountId !== next.accountId
    ) {
      vault.verifiedLogin = { fingerprint, ...next }
      // Only a cache: losing it costs one read on request.
      await this.store.write(vault).catch(() => undefined)
    }
    return next
  }

  /** Which account `current` is, as far as the saved ones tell. */
  view(vault: AntigravityAccountVault, current: AntigravityNativeCredential): AntigravityLoginView {
    const active = vault.accounts.find((entry) => this.matches(entry, current))
    return {
      email: current.identity ? current.identity.email : (active?.email ?? null),
      subject: current.identity?.subject ?? active?.subject ?? null,
      authMethod: current.authMethod,
      accountId: active?.id ?? null
    }
  }
}

/** `unread`: agy is signed in, but which account isn't known without reading its login. */
export function antigravityAccountState(
  vault: AntigravityAccountVault,
  login: AntigravityLoginView | 'unread' | null,
  restoresSelectionAtLaunch: boolean
): AntigravityAccountState {
  const known = login === 'unread' ? null : login
  const activeAccountId =
    known?.accountId && vault.accounts.some((entry) => entry.id === known.accountId)
      ? known.accountId
      : null
  return {
    accounts: vault.accounts.map((account) => {
      const { credentials: _credentials, ...summary } = account
      return summary
    }),
    activeAccountId,
    selectedAccountId: vault.selectedAccountId,
    ...(restoresSelectionAtLaunch ? { restoresSelectionAtLaunch: true as const } : {}),
    currentAccount:
      login === 'unread'
        ? { email: null, subject: null, authMethod: '', identityKnown: false, unread: true }
        : known
          ? {
              email: known.email,
              subject: known.subject,
              authMethod: known.authMethod,
              identityKnown: known.subject !== null
            }
          : null
  }
}
