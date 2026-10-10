import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { getAppEnvironment } from '../../shared/app-environment'
import { writeSecureFile } from '../../shared/secure-file'
import type {
  ManagedDataAccountProvider,
  ManagedDataAccountsState
} from '../../shared/managed-account-types'
import { captureDataAccountCredentials } from './credential-capture'
import { ManagedDataAccountProfileRemoval } from './profile-removal'
import {
  captureManagedDataAccountOriginalEnvironment,
  restoreManagedDataAccountEnvironment
} from '../../shared/managed-data-account-environment'

const MAX_INLINE_AUTH_BASELINES = 64
const MAX_INLINE_AUTH_BYTES = 64 * 1024

type InlineAuthBaseline = { value: string; selections: Set<string> }

const stateSchema = z.object({
  accounts: z
    .array(
      z.object({
        id: z.uuid(),
        label: z.string().min(1).max(120),
        integrations: z.array(z.string()).max(64),
        createdAt: z.number()
      })
    )
    .max(64),
  activeAccountId: z.uuid().nullable()
})

export class ManagedDataAccountService {
  private pending: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  private readonly inlineAuthBaselines = new Map<string, InlineAuthBaseline>()
  private readonly profileRemoval: ManagedDataAccountProfileRemoval

  constructor(
    private readonly root: string,
    removeDirectory?: (directory: string) => void | Promise<void>
  ) {
    this.profileRemoval = new ManagedDataAccountProfileRemoval(
      root,
      (path) => this.assertOwned(path),
      (contents) => stateSchema.parse(JSON.parse(contents)),
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
        return this.persist(provider, {
          accounts: [...state.accounts, { id, label, integrations, createdAt: Date.now() }],
          activeAccountId: id
        })
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
          // Unreadable metadata cannot prove that this profile is unregistered.
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
      return this.persist(provider, { ...state, activeAccountId })
    })
  }

  remove(
    provider: ManagedDataAccountProvider,
    accountId: string
  ): Promise<ManagedDataAccountsState> {
    return this.mutate(() =>
      this.profileRemoval.remove(
        provider,
        accountId,
        this.list(provider),
        (next) => this.writeState(provider, next),
        () => this.notifyChanged()
      )
    )
  }

  launchEnvironment(provider: ManagedDataAccountProvider): Record<string, string> {
    const state = this.list(provider)
    if (!state.activeAccountId) {
      return {}
    }
    return this.environmentForAccount(provider, state.activeAccountId)
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
    const value = environment.OPENCODE_AUTH_CONTENT
    let reference: string | undefined
    if (value && selected.OPENCODE_AUTH_CONTENT === '') {
      if (Buffer.byteLength(value, 'utf8') > MAX_INLINE_AUTH_BYTES) {
        throw new Error('Inline authentication exceeds the managed launch limit.')
      }
      const selection = JSON.stringify([selected.XDG_DATA_HOME, selected.XDG_STATE_HOME])
      const existing = [...this.inlineAuthBaselines].find(([, entry]) => entry.value === value)
      if (existing) {
        const [id, entry] = existing
        if (
          !entry.selections.has(selection) &&
          entry.selections.size >= MAX_INLINE_AUTH_BASELINES
        ) {
          throw new Error('Managed inline authentication context limit reached.')
        }
        entry.selections.add(selection)
        reference = id
      } else {
        if (this.inlineAuthBaselines.size >= MAX_INLINE_AUTH_BASELINES) {
          throw new Error('Managed inline authentication baseline limit reached.')
        }
        reference = randomUUID()
        this.inlineAuthBaselines.set(reference, { value, selections: new Set([selection]) })
      }
    }
    captureManagedDataAccountOriginalEnvironment(environment, reference)
  }

  restoreOriginalEnvironment(environment: Record<string, string | undefined>): void {
    // A copied reference needs the exact overlay captured by this host service.
    const selection = JSON.stringify([
      environment.ORCA_DATA_ACCOUNT_DATA_HOME,
      environment.ORCA_DATA_ACCOUNT_STATE_HOME
    ])
    const ownsSelection =
      environment.ORCA_DATA_ACCOUNT_PROVIDER === 'opencode' &&
      environment.OPENCODE_AUTH_CONTENT === '' &&
      environment.OPENCODE_DB === 'opencode.db' &&
      environment.XDG_DATA_HOME === environment.ORCA_DATA_ACCOUNT_DATA_HOME &&
      environment.XDG_STATE_HOME === environment.ORCA_DATA_ACCOUNT_STATE_HOME
    restoreManagedDataAccountEnvironment(environment, true, (reference) => {
      const baseline = this.inlineAuthBaselines.get(reference)
      return ownsSelection && baseline?.selections.has(selection) ? baseline.value : undefined
    })
  }

  clearInlineAuthBaselines(): void {
    this.inlineAuthBaselines.clear()
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

  private readState(path: string): ManagedDataAccountsState {
    this.assertOwned(path)
    return stateSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  }

  private writeState(
    provider: ManagedDataAccountProvider,
    state: ManagedDataAccountsState
  ): ManagedDataAccountsState {
    const checked = stateSchema.parse(state)
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
