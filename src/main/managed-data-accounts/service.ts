import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { writeSecureFile } from '../../shared/secure-storage/secure-file'
import type {
  ManagedDataAccountProvider,
  ManagedDataAccountsState
} from '../../shared/managed-account-types'
import { captureDataAccountCredentials } from './credential-capture'
import { DevinHostAccountSelection } from './devin-host-account-selection'
import { ManagedDataAccountProfileRemoval } from './profile-removal'
import { ManagedDataAccountEnvironmentBaselineState } from './environment-baseline-state'
import { managedDataAccountStateSchema } from './registry-state'

export type ManagedDataAccountServiceOptions = {
  platform?: NodeJS.Platform
  devinAppDataRoot?: string
}

export class ManagedDataAccountService {
  private pending: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  private readonly environmentBaselineState = new ManagedDataAccountEnvironmentBaselineState()
  private readonly profileRemoval: ManagedDataAccountProfileRemoval
  private readonly devinHostAccountSelection: DevinHostAccountSelection

  constructor(
    private readonly root: string,
    removeDirectory?: (directory: string) => void | Promise<void>,
    options: ManagedDataAccountServiceOptions = {}
  ) {
    this.devinHostAccountSelection = new DevinHostAccountSelection({
      root,
      platform: options.platform ?? process.platform,
      appDataRoot: options.devinAppDataRoot,
      accountDirectory: (accountId) => this.requireAccount('devin', accountId).directory,
      assertOwned: (path) => this.assertOwned(path)
    })
    this.profileRemoval = new ManagedDataAccountProfileRemoval(
      root,
      (path) => this.assertOwned(path),
      (contents) => managedDataAccountStateSchema.parse(JSON.parse(contents)),
      removeDirectory
    )
    if (existsSync(root)) {
      for (const provider of ['opencode', 'devin'] as const) {
        void this.mutate(async () => {
          const registered = new Set(this.list(provider).accounts.map((account) => account.id))
          await this.profileRemoval.retry(provider, registered)
        }).catch(() => {
          console.warn(
            '[managed-data-accounts] Could not read accounts for private directory cleanup.'
          )
        })
      }
    }
  }

  list(provider: ManagedDataAccountProvider): ManagedDataAccountsState {
    const path = join(this.root, provider, 'accounts.json')
    if (!existsSync(path)) {
      return { accounts: [], activeAccountId: null }
    }
    return this.readState(path)
  }

  add(
    provider: ManagedDataAccountProvider,
    sourceDataHome: string,
    label: string
  ): Promise<ManagedDataAccountsState> {
    return this.mutate(async () => {
      const state = this.list(provider)
      if (state.accounts.length >= 64) {
        throw new Error('Managed account limit reached.')
      }
      const id = randomUUID()
      const directory = join(this.root, provider, id)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      this.assertOwned(directory)
      try {
        const integrations = await captureDataAccountCredentials(
          provider,
          sourceDataHome,
          join(directory, 'data')
        )
        return await this.persistSelectionTransition(
          provider,
          state,
          {
            accounts: [...state.accounts, { id, label, integrations, createdAt: Date.now() }],
            activeAccountId: id
          },
          directory
        )
      } catch (error) {
        let registered = true
        try {
          registered = this.readState(join(this.root, provider, 'accounts.json')).accounts.some(
            (account) => account.id.toLowerCase() === id.toLowerCase()
          )
        } catch (metadataError) {
          if (
            metadataError instanceof Error &&
            'code' in metadataError &&
            metadataError.code === 'ENOENT'
          ) {
            registered = false
          }
          // Unreadable registry metadata cannot prove the profile is unregistered.
        }
        if (!registered) {
          rmSync(directory, { recursive: true, force: true })
        }
        throw error
      }
    })
  }

  select(
    provider: ManagedDataAccountProvider,
    accountId: string | null
  ): Promise<ManagedDataAccountsState> {
    return this.mutate(async () => {
      const state = this.list(provider)
      const activeAccountId =
        accountId === null ? null : this.requireAccount(provider, accountId).id
      return this.persistSelectionTransition(provider, state, { ...state, activeAccountId })
    })
  }

  remove(
    provider: ManagedDataAccountProvider,
    accountId: string
  ): Promise<ManagedDataAccountsState> {
    return this.mutate(async () => {
      const state = this.list(provider)
      return this.devinHostAccountSelection.remove(provider, state, accountId, () =>
        this.profileRemoval.remove(
          provider,
          accountId,
          state,
          (next) => this.writeState(provider, next),
          () => this.notifyChanged()
        )
      )
    })
  }

  launchEnvironment(provider: ManagedDataAccountProvider): Record<string, string> {
    const state = this.list(provider)
    if (!state.activeAccountId) {
      return {}
    }
    return this.environmentForAccount(provider, state.activeAccountId)
  }

  async syncLaunchCredentials(
    provider: ManagedDataAccountProvider,
    selectedEnvironment: Record<string, string>
  ): Promise<void> {
    if (provider !== 'devin') {
      return
    }
    // Why: serialize with select/remove so a launch cannot overwrite the host
    // credential after a concurrent switch to System restored and dropped its backup.
    await this.mutate(() =>
      this.devinHostAccountSelection.syncLaunchCredentials(
        provider,
        selectedEnvironment,
        this.list('devin').accounts
      )
    )
  }

  transcriptEnvironments(provider: ManagedDataAccountProvider): Record<string, string>[] {
    const state = this.list(provider)
    const selected = state.accounts.filter((account) => account.id === state.activeAccountId)
    const others = state.accounts.filter((account) => account.id !== state.activeAccountId)
    return [...selected, ...others].map((account) =>
      this.environmentForAccount(provider, account.id)
    )
  }

  captureOriginalEnvironment(
    environment: Record<string, string>,
    selected: Record<string, string>
  ): void {
    this.environmentBaselineState.captureOriginalEnvironment(environment, selected)
  }

  restoreOriginalEnvironment(environment: Record<string, string | undefined>): void {
    this.environmentBaselineState.restoreOriginalEnvironment(environment)
  }

  clearInlineAuthBaselines(): void {
    this.environmentBaselineState.clear()
  }

  environmentForAccount(
    provider: ManagedDataAccountProvider,
    accountId: string
  ): Record<string, string> {
    const { directory } = this.requireAccount(provider, accountId)
    return {
      XDG_DATA_HOME: join(directory, 'data'),
      XDG_STATE_HOME: join(directory, 'state'),
      ...(provider === 'opencode' ? { OPENCODE_DB: 'opencode.db', OPENCODE_AUTH_CONTENT: '' } : {})
    }
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private requireAccount(
    provider: ManagedDataAccountProvider,
    id: string
  ): { id: string; directory: string } {
    const account = this.list(provider).accounts.find(
      (registered) => registered.id.toLowerCase() === id.toLowerCase()
    )
    if (!account) {
      throw new Error('Managed account not found.')
    }
    const directory = join(this.root, provider, account.id.toLowerCase())
    this.assertOwned(directory)
    return { id: account.id, directory }
  }

  private persist(
    provider: ManagedDataAccountProvider,
    state: ManagedDataAccountsState
  ): ManagedDataAccountsState {
    const checked = this.writeState(provider, state)
    this.notifyChanged()
    return checked
  }

  private persistSelectionTransition(
    provider: ManagedDataAccountProvider,
    previous: ManagedDataAccountsState,
    next: ManagedDataAccountsState,
    unregisteredDirectory?: string
  ): Promise<ManagedDataAccountsState> {
    return this.devinHostAccountSelection.persistTransition(
      provider,
      previous,
      next,
      () => this.persist(provider, next),
      () => this.list(provider).activeAccountId,
      unregisteredDirectory
    )
  }

  private readState(path: string): ManagedDataAccountsState {
    this.assertOwned(path)
    return managedDataAccountStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  }

  private writeState(
    provider: ManagedDataAccountProvider,
    state: ManagedDataAccountsState
  ): ManagedDataAccountsState {
    const checked = managedDataAccountStateSchema.parse(state)
    const path = join(this.root, provider, 'accounts.json')
    if (existsSync(path)) {
      this.assertOwned(path)
    }
    if (!writeSecureFile(path, JSON.stringify(checked), { durable: true })) {
      throw new Error('Could not restrict account metadata permissions.')
    }
    return checked
  }

  private notifyChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        console.warn('[managed-data-accounts] Account change listener failed.')
      }
    }
  }

  private assertOwned(path: string): void {
    if (
      lstatSync(this.root).isSymbolicLink() ||
      lstatSync(path).isSymbolicLink() ||
      !realpathSync(path).startsWith(realpathSync(this.root) + sep)
    ) {
      throw new Error('Managed account path is outside Orca account storage.')
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation)
    this.pending = next.catch(() => {})
    return next
  }
}

let instance: { root: string; service: ManagedDataAccountService } | undefined
let shutdownHookInstalled = false

export function getManagedDataAccountService(): ManagedDataAccountService {
  const root = resolve(getAppEnvironment().getPath('userData'), 'managed-data-accounts')
  if (instance?.root !== root) {
    instance?.service.clearInlineAuthBaselines()
    instance = { root, service: new ManagedDataAccountService(root) }
  }
  if (!shutdownHookInstalled) {
    getAppEnvironment().onWillQuit(() => {
      instance?.service.clearInlineAuthBaselines()
      instance = undefined
    })
    shutdownHookInstalled = true
  }
  return instance.service
}
