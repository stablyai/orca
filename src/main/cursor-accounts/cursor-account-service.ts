import { randomUUID } from 'node:crypto'
import type { CursorSavedAccountsState } from '../../shared/cursor-account-types'
import type { CursorCredentialBackend } from './cursor-macos-credential-backend'
import type { CursorAccountStore, CursorAccountVault } from './cursor-account-store'
import {
  parseCursorSnapshot,
  serializeCursorSnapshot,
  type CursorNativeCredential
} from './cursor-native-credential'

/** Saves and switches the Cursor CLI sign-in. An account is identified by the access token's subject, which survives token refreshes. */
export class CursorAccountService {
  private mutation: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: CursorAccountStore,
    private readonly backend: CursorCredentialBackend,
    private readonly now: () => number = Date.now
  ) {}

  list(): Promise<CursorSavedAccountsState> {
    return this.serialize(async () => this.state(await this.reconcile()))
  }

  addCurrent(): Promise<CursorSavedAccountsState> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
      if (!current) {
        throw new Error(
          'Sign in with cursor-agent on this computer, then save the current account.'
        )
      }
      if (!vault.accounts.some((account) => account.subject === current.subject)) {
        const timestamp = this.now()
        vault.accounts.push({
          id: randomUUID(),
          email: current.email,
          displayName: current.displayName,
          subject: current.subject,
          credentials: serializeCursorSnapshot(current.snapshot),
          createdAt: timestamp,
          updatedAt: timestamp
        })
        this.store.write(vault)
      }
      return this.state({ vault, current })
    })
  }

  select(id: string): Promise<CursorSavedAccountsState> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
      const selected = vault.accounts.find((account) => account.id === id)
      if (!selected) {
        throw new Error('Cursor account was not found.')
      }
      if (current && current.subject !== selected.subject) {
        // Never overwrite a sign-in Orca has not saved.
        if (!vault.accounts.some((account) => account.subject === current.subject)) {
          throw new Error('Save the current Cursor account before switching to another one.')
        }
      }
      if (current?.subject !== selected.subject) {
        await this.backend.write(
          parseCursorSnapshot(selected.credentials).snapshot,
          current?.snapshot.accessToken ?? null
        )
      }
      const readback = await this.backend.read()
      if (readback?.subject !== selected.subject) {
        throw new Error('Cursor account switching could not be verified; refresh before retrying.')
      }
      vault.selectedAccountId = id
      this.store.write(vault)
      return this.state({ vault, current: readback })
    })
  }

  remove(id: string): Promise<CursorSavedAccountsState> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
      const account = vault.accounts.find((entry) => entry.id === id)
      if (!account) {
        throw new Error('Cursor account was not found.')
      }
      if (vault.selectedAccountId === id || current?.subject === account.subject) {
        throw new Error('Switch to another Cursor account before removing this one.')
      }
      vault.accounts = vault.accounts.filter((entry) => entry.id !== id)
      this.store.write(vault)
      return this.state({ vault, current })
    })
  }

  /** cursor-agent rotates tokens on its own, so a signed-in saved account keeps its latest snapshot. */
  private async reconcile(): Promise<{
    vault: CursorAccountVault
    current: CursorNativeCredential | null
  }> {
    const current = await this.backend.read()
    // Re-read after native I/O so a delayed read never restores an older vault.
    const vault = this.store.read()
    const saved = current && vault.accounts.find((account) => account.subject === current.subject)
    if (current && saved) {
      const credentials = serializeCursorSnapshot(current.snapshot)
      if (saved.credentials !== credentials) {
        saved.credentials = credentials
        saved.email = current.email ?? saved.email
        saved.displayName = current.displayName ?? saved.displayName
        saved.updatedAt = this.now()
        this.store.write(vault)
      }
    }
    return { vault, current }
  }

  private state({
    vault,
    current
  }: {
    vault: CursorAccountVault
    current: CursorNativeCredential | null
  }): CursorSavedAccountsState {
    const active = current
      ? vault.accounts.find((account) => account.subject === current.subject)
      : undefined
    return {
      supported: true,
      accounts: vault.accounts.map(({ credentials: _credentials, ...summary }) => summary),
      activeAccountId: active?.id ?? null,
      selectedAccountId: vault.selectedAccountId,
      currentUnsaved: current !== null && !active
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation, operation)
    this.mutation = next.catch(() => undefined)
    return next
  }
}
