import type { AntigravityAccountState } from '../../shared/agent-accounts/antigravity/antigravity-account-types'
import {
  parseAntigravityNativeCredential,
  type AntigravityNativeCredential
} from './native-credential-codec'
import { keychainAccessIsBrief, type AntigravityKeychainRevision } from './native-macos-credentials'
import type {
  AntigravityAccountStore,
  AntigravityAccountVault,
  StoredAntigravityAccount,
  VerifiedAntigravityLogin
} from './native-account-store'

/** A keychain item's revision, whose `fingerprint` changes whenever its login is rewritten, or
 *  the login itself where it is stored somewhere reading it raises no dialog. */
export type AntigravityQuietRead =
  | AntigravityKeychainRevision
  | { credential: AntigravityNativeCredential | null }

export type AntigravityLoginView = Omit<VerifiedAntigravityLogin, 'fingerprint'>

type LoginBackend = {
  read(): Promise<AntigravityNativeCredential | null>
  readWithoutPrompt?(): Promise<AntigravityQuietRead>
}

/** Whether `current` is `account`'s login, refreshed or not. */
export function antigravityLoginMatches(
  account: StoredAntigravityAccount,
  current: AntigravityNativeCredential,
  parseCredential = parseAntigravityNativeCredential
): boolean {
  if (current.identity && account.subject) {
    return account.subject === current.identity.subject && account.authMethod === current.authMethod
  }
  // agy's token refresh stores no id_token but keeps the grant's refresh token.
  if (
    current.refreshToken &&
    account.authMethod === current.authMethod &&
    parseCredential(account.credentials).refreshToken === current.refreshToken
  ) {
    return true
  }
  return account.credentials === current.contents
}

/** Reads agy's login and remembers, by its keychain item's fingerprint, which account the last read
 *  found, so a listing can name it without the read and the keychain dialog it may raise. */
export class AntigravityLoginReader {
  // The latest login read under a fingerprint that held still across the read, until a listing
  // keeps it in the vault.
  private lastRead: { fingerprint: string; current: AntigravityNativeCredential } | null = null
  // Why the latest read under a fingerprint failed, so launches don't raise the dialog again.
  private refused: { fingerprint: string; error: unknown } | null = null
  /** A brief access (a chat start's) failed; a read that may wait on the dialog clears it. */
  briefAccessFailed = false

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
    let before = quiet ?? (await quietRead())
    if (before && 'credential' in before) {
      return { current: before.credential, fingerprint: null }
    }
    const brief = keychainAccessIsBrief()
    const wait = before && !brief ? before.stableFrom - Date.now() : 0
    if (wait > 0 && wait <= 1000) {
      // A write later in the item's last second would keep its fingerprint, so only a read begun
      // after that second can vouch for the login it finds.
      await new Promise((resolve) => setTimeout(resolve, wait))
      before = await quietRead()
      if (before && 'credential' in before) {
        return { current: before.credential, fingerprint: null }
      }
    }
    let current: AntigravityNativeCredential | null
    try {
      current = await this.backend.read()
    } catch (error) {
      // A brief read gave up early, so a launch that can wait for the dialog may still ask.
      if (!brief) {
        this.refused = before ? { fingerprint: before.fingerprint, error } : null
      }
      throw error
    }
    this.refused = null
    this.briefAccessFailed &&= brief
    const after = before ? await quietRead() : undefined
    return {
      current,
      fingerprint:
        before?.settled &&
        after &&
        'fingerprint' in after &&
        after.fingerprint === before.fingerprint
          ? before.fingerprint
          : null
    }
  }

  note(fingerprint: string | null, current: AntigravityNativeCredential | null): void {
    if (fingerprint && current) {
      this.lastRead = { fingerprint, current }
    }
  }

  /** For a launch, where reading agy's login may raise a keychain dialog: true when nothing is
   *  selected or the last read under the fingerprint found the selected account; throws the last
   *  read's error when it failed under this fingerprint, so the launch doesn't raise it again. */
  async settlesLaunch(quiet: AntigravityQuietRead | undefined, persist: boolean): Promise<boolean> {
    if (!quiet || !('fingerprint' in quiet)) {
      return false
    }
    const vault = await this.store.read()
    const login = await this.known(vault, quiet.fingerprint, persist)
    if (!vault.selectedAccountId || login?.accountId === vault.selectedAccountId) {
      return true
    }
    if (this.refused?.fingerprint === quiet.fingerprint) {
      throw this.refused.error
    }
    return false
  }

  /** The login last read while agy's keychain item still has `fingerprint`, kept in the vault so it
   *  outlives a restart; null when agy rewrote its login since. `persist: false` writes nothing, for
   *  callers outside the account queue whose vault write could undo a queued one. */
  async known(
    vault: AntigravityAccountVault,
    fingerprint: string,
    persist = true
  ): Promise<AntigravityLoginView | null> {
    if (this.lastRead?.fingerprint !== fingerprint) {
      const cached = vault.verifiedLogin?.fingerprint === fingerprint ? vault.verifiedLogin : null
      // The login may have been saved since it was read.
      const saved =
        cached?.subject &&
        vault.accounts.find(
          (entry) => entry.subject === cached.subject && entry.authMethod === cached.authMethod
        )
      return cached && saved && !cached.accountId ? { ...cached, accountId: saved.id } : cached
    }
    const next = this.view(vault, this.lastRead.current)
    if (!persist) {
      return next
    }
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
