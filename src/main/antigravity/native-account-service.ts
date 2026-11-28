import { randomUUID } from 'node:crypto'
import type { AntigravityAccountState } from '../../shared/agent-accounts/antigravity/antigravity-account-types'
import {
  parseAntigravityNativeCredential,
  type AntigravityNativeCredential
} from './native-credential-codec'
import { fetchGoogleIdentity } from './google-userinfo-identity'
import { AntigravityRewrittenLoginIdentity } from './native-account-rewritten-login'
import type {
  AntigravityAccountStore,
  AntigravityAccountVault,
  StoredAntigravityAccount
} from './native-account-store'
import {
  AntigravityLoginReader,
  antigravityAccountState,
  antigravityLoginMatches,
  type AntigravityQuietRead
} from './native-account-login-view'
import { AntigravityKeychainAccessError, withBriefKeychainAccess } from './native-macos-credentials'

export type AntigravityCredentialBackend = {
  parse?(contents: string): AntigravityNativeCredential
  read(): Promise<AntigravityNativeCredential | null>
  write(contents: string, expected: string | null): Promise<void>
  /** Only where `read` can raise a keychain dialog (macOS): what Orca can learn without one. */
  readWithoutPrompt?(): Promise<AntigravityQuietRead>
}

export type AntigravityLaunchRestore = {
  /** True while Orca's own agy sign-in may have put a login it hasn't saved yet in the slot. */
  signInHoldsLogin: () => boolean
}

export class AntigravityAccountService {
  private mutation: Promise<unknown> = Promise.resolve()
  // Queued or running operations that may wait on a keychain dialog.
  private prompting = 0
  private readonly logins: AntigravityLoginReader
  private readonly rewrittenLogins = new AntigravityRewrittenLoginIdentity(
    () => this.lookupIdentity
  )

  constructor(
    private readonly store: AntigravityAccountStore,
    private readonly backend: AntigravityCredentialBackend,
    private readonly now: () => number = Date.now,
    private readonly lookupIdentity = fetchGoogleIdentity,
    // Only the host's service restores at launch; absent, launches still refuse a moved login.
    private readonly launchRestore?: AntigravityLaunchRestore
  ) {
    this.logins = new AntigravityLoginReader(backend, store, (account, login) =>
      this.matches(account, login)
    )
  }

  /** Resolves once every account operation queued before it has finished. */
  settled(): Promise<void> {
    return this.serialize(async () => {}, false)
  }

  /** Never reads a login whose read could raise a keychain dialog: such a login is named from
   *  the last read while its keychain item is unchanged, else listed as signed in but unread. */
  async listAccounts(): Promise<AntigravityAccountState> {
    // Queued work may be waiting on a keychain dialog, which a keychain login lists without.
    const early = this.prompting > 0 ? await this.backend.readWithoutPrompt?.() : undefined
    return early && 'fingerprint' in early
      ? this.listKeychainLogin(early.fingerprint, false)
      : this.serialize(async () => {
          const quiet = await this.backend.readWithoutPrompt?.()
          return quiet && 'fingerprint' in quiet
            ? this.listKeychainLogin(quiet.fingerprint, true)
            : this.state(await this.reconcile(undefined, quiet))
        }, false)
  }

  private async listKeychainLogin(fingerprint: string, persist: boolean) {
    const vault = await this.store.read()
    const login = (await this.logins.known(vault, fingerprint, persist)) ?? 'unread'
    return antigravityAccountState(vault, login, Boolean(this.launchRestore))
  }

  /** Reads agy's login even where that may raise a keychain dialog; only for an explicit request. */
  readCurrentAccount(): Promise<AntigravityAccountState> {
    return this.serialize(async () => this.state(await this.reconcile()))
  }

  addCurrentAccount(): Promise<AntigravityAccountState> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
      if (!current) {
        throw new Error('Sign in with agy on this execution host, then save the current account.')
      }
      if (vault.accounts.some((entry) => this.matches(entry, current))) {
        return this.state({ vault, current })
      }
      const identity = current.identity ?? (await this.lookupIdentity(current.accessToken))
      if (!current.identity && (await this.backend.read())?.contents !== current.contents) {
        throw new Error('The native Antigravity account changed. Save the current account again.')
      }
      const identified = { ...current, identity }
      const latest = await this.store.read()
      if (!latest.accounts.some((entry) => this.matches(entry, identified))) {
        const timestamp = this.now()
        latest.accounts.push({
          id: randomUUID(),
          email: identity.email,
          subject: identity.subject,
          authMethod: current.authMethod,
          credentials: current.contents,
          createdAt: timestamp,
          updatedAt: timestamp
        })
      }
      this.updateSnapshot(latest, identified)
      await this.store.write(latest)
      return this.state({ vault: latest, current: identified })
    })
  }

  /** `switched` runs once agy holds another login than before and the switch is saved. */
  selectAccount(id: string, switched?: () => void): Promise<AntigravityAccountState> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile(id)
      const selected = vault.accounts.find((account) => account.id === id)
      if (!selected) {
        throw new Error('Antigravity account was not found.')
      }
      const { readback, switching } = await this.switchNative(selected, current)
      const latest = await this.store.read()
      if (
        !latest.accounts.some((account) => account.id === id && this.matches(account, readback))
      ) {
        throw new Error('Antigravity snapshots changed during selection; refresh before retrying.')
      }
      latest.selectedAccountId = id
      this.updateSnapshot(latest, readback)
      await this.store.write(latest)
      if (switching) {
        switched?.()
      }
      return this.state({ vault: latest, current: readback })
    })
  }

  removeAccount(id: string): Promise<AntigravityAccountState> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
      const account = vault.accounts.find((entry) => entry.id === id)
      if (!account) {
        throw new Error('Antigravity account was not found.')
      }
      if (current && this.matches(account, current)) {
        throw new Error('Switch agy to another account before removing the one it is signed in to.')
      }
      vault.accounts = vault.accounts.filter((entry) => entry.id !== id)
      // Only Orca's snapshot goes; agy keeps its own login, so a removed selection must stop gating launches.
      if (vault.selectedAccountId === id) {
        vault.selectedAccountId = null
      }
      await this.store.write(vault)
      return this.state({ vault, current })
    })
  }

  /** `mayPrompt: false` (a chat start) never waits on a keychain dialog: it skips the restore while
   *  other account work runs, reads agy's login only briefly, and not again once that failed. */
  async prepareForLaunch({ mayPrompt = true }: { mayPrompt?: boolean } = {}): Promise<void> {
    const early = mayPrompt ? undefined : await this.backend.readWithoutPrompt?.()
    if (await this.logins.settlesLaunch(early, false)) {
      return
    }
    if (early && 'fingerprint' in early && (this.logins.briefAccessFailed || this.prompting > 0)) {
      throw new Error(
        "Checking agy's login for the selected account could ask for keychain access, so it was left as it is."
      )
    }
    const restore = async () => {
      const quiet = await this.backend.readWithoutPrompt?.()
      if (await this.logins.settlesLaunch(quiet, true)) {
        return
      }
      const { vault, current } = await this.reconcile(undefined, quiet)
      const selected = vault.accounts.find((account) => account.id === vault.selectedAccountId)
      if (!vault.selectedAccountId || (selected && current && this.matches(selected, current))) {
        return
      }
      // Each running agy writes its own login back to the one native slot on every token refresh.
      // Exactly one saved account holding it (reconcile just saved it) restores the selection, as
      // best effort as selecting: the native store has no compare-and-swap.
      const holders = current ? vault.accounts.filter((entry) => this.matches(entry, current)) : []
      if (!selected || holders.length !== 1 || !this.launchRestore) {
        throw new Error(
          'The native Antigravity account changed. Select the account again in Accounts before launching agy.'
        )
      }
      if (this.launchRestore.signInHoldsLogin()) {
        throw new Error('Antigravity sign-in is in progress. Finish it, then launch agy again.')
      }
      await this.switchNative(selected, current)
      // No vault write: both logins are already saved, and another Orca process selecting meanwhile wins.
      if ((await this.store.read()).selectedAccountId !== selected.id) {
        throw new Error('Antigravity snapshots changed during selection; refresh before retrying.')
      }
    }
    // A chat's keychain calls give up early; one the keychain refused or left unanswered stops the
    // next chats asking, while other refusals (a sign-in in progress) don't.
    const chatRestore = () =>
      withBriefKeychainAccess(restore).catch((error: unknown) => {
        this.logins.briefAccessFailed ||= error instanceof AntigravityKeychainAccessError
        throw error
      })
    return this.serialize(mayPrompt ? restore : chatRestore, mayPrompt)
  }

  private async switchNative(
    selected: StoredAntigravityAccount,
    current: AntigravityNativeCredential | null
  ) {
    const switching = !current || !this.matches(selected, current)
    if (switching) {
      await this.backend.write(selected.credentials, current?.contents ?? null)
    }
    const { current: readback, fingerprint } = await this.logins.read()
    this.logins.note(fingerprint, readback)
    if (!readback || !this.matches(selected, readback)) {
      throw new Error(
        'Antigravity account switching could not be verified; refresh before retrying.'
      )
    }
    return { readback, switching }
  }

  private matches(
    account: StoredAntigravityAccount,
    current: AntigravityNativeCredential
  ): boolean {
    return antigravityLoginMatches(account, current, this.backend.parse)
  }

  /** `quiet`: what the caller already read without a prompt, so it isn't read twice. */
  private async reconcile(selectedId?: string, quiet?: AntigravityQuietRead) {
    const native = await this.logins.read(quiet)
    const current = await this.rewrittenLogins.identify(
      native.current,
      (await this.store.read()).accounts,
      (account, login) => this.matches(account, login)
    )
    this.logins.note(native.fingerprint, current)
    // Re-read after native I/O so a delayed read never restores an older vault.
    const vault = await this.store.read()
    if (selectedId !== undefined) {
      const selected = vault.accounts.find((account) => account.id === selectedId)
      if (!selected) {
        throw new Error('Antigravity account was not found.')
      }
      const parseCredential = this.backend.parse ?? parseAntigravityNativeCredential
      parseCredential(selected.credentials)
    }
    if (current && this.updateSnapshot(vault, current)) {
      await this.store.write(vault)
    }
    return { vault, current }
  }

  private updateSnapshot(
    vault: AntigravityAccountVault,
    current: AntigravityNativeCredential
  ): boolean {
    const account = vault.accounts.find((entry) => this.matches(entry, current))
    if (!account || account.credentials === current.contents) {
      return false
    }
    account.credentials = current.contents
    account.email = current.identity?.email ?? account.email
    account.updatedAt = this.now()
    return true
  }

  private state({
    vault,
    current
  }: {
    vault: AntigravityAccountVault
    current: AntigravityNativeCredential | null
  }): AntigravityAccountState {
    const login = current ? this.logins.view(vault, current) : null
    return antigravityAccountState(vault, login, Boolean(this.launchRestore))
  }

  private serialize<T>(operation: () => Promise<T>, mayPrompt = true): Promise<T> {
    const prompts = Number(mayPrompt)
    this.prompting += prompts
    const next = this.mutation.then(operation, operation).finally(() => (this.prompting -= prompts))
    this.mutation = next.catch(() => undefined)
    return next
  }
}
