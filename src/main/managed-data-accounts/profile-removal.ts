import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { removeHostTree } from '../host-tree-removal'
import type {
  ManagedDataAccountProvider,
  ManagedDataAccountsState
} from '../../shared/managed-account-types'
import { writeSecureFile } from '../../shared/secure-file'

export class ManagedDataAccountProfileRemoval {
  constructor(
    private readonly root: string,
    private readonly assertOwned: (path: string) => void,
    private readonly parseState: (contents: string) => ManagedDataAccountsState,
    private readonly removeDirectory: (directory: string) => void | Promise<void> = removeHostTree
  ) {}

  async remove(
    provider: ManagedDataAccountProvider,
    accountId: string,
    state: ManagedDataAccountsState,
    publish: (state: ManagedDataAccountsState) => ManagedDataAccountsState,
    changed: () => void
  ): Promise<ManagedDataAccountsState> {
    if (!z.uuid().safeParse(accountId).success) {
      throw new Error('Managed account not found.')
    }
    const pathId = accountId.toLowerCase()
    const directory = join(this.root, provider, pathId)
    const pendingDirectory = join(this.root, provider, '.pending-delete', pathId)
    const metadataPath = join(this.root, provider, 'accounts.json')
    const rollbackPath = `${metadataPath}.${pathId}.rollback`
    if (!state.accounts.some((account) => account.id === accountId)) {
      if (state.accounts.some((account) => account.id.toLowerCase() === accountId.toLowerCase())) {
        throw new Error('Managed account not found.')
      }
      if (existsSync(directory)) {
        if (!this.hasRemovalBackup(rollbackPath, accountId)) {
          throw new Error('Managed account not found.')
        }
        this.quarantine(directory, pendingDirectory)
        changed()
      } else if (!existsSync(pendingDirectory) && !this.hasRemovalBackup(rollbackPath, accountId)) {
        throw new Error('Managed account not found.')
      }
      this.discardBackup(rollbackPath)
      await this.cleanup(pendingDirectory)
      return state
    }
    if (existsSync(rollbackPath)) {
      this.assertOwned(rollbackPath)
    }
    if (!writeSecureFile(rollbackPath, readFileSync(metadataPath, 'utf8'), { durable: true })) {
      rmSync(rollbackPath, { force: true })
      throw new Error('Could not restrict account metadata backup permissions.')
    }
    let next: ManagedDataAccountsState
    try {
      next = publish({
        accounts: state.accounts.filter((account) => account.id !== accountId),
        activeAccountId: state.activeAccountId === accountId ? null : state.activeAccountId
      })
      this.quarantine(directory, pendingDirectory)
    } catch (error) {
      try {
        renameSync(rollbackPath, metadataPath)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Account removal failed and its private metadata backup could not be restored; retry removal to recover.',
          { cause: error }
        )
      }
      throw error
    }
    this.discardBackup(rollbackPath)
    changed()
    // Cleanup can partially delete a tree, so it must never roll back a committed removal.
    await this.cleanup(pendingDirectory)
    return next
  }

  private quarantine(directory: string, pendingDirectory: string): void {
    if (!existsSync(directory)) {
      return
    }
    this.assertOwned(dirname(directory))
    this.assertOwned(directory)
    if (existsSync(pendingDirectory)) {
      throw new Error('Account already has a pending removal directory.')
    }
    const pendingRoot = dirname(pendingDirectory)
    mkdirSync(pendingRoot, { recursive: true, mode: 0o700 })
    this.assertOwned(pendingRoot)
    renameSync(directory, pendingDirectory)
  }

  private hasRemovalBackup(rollbackPath: string, accountId: string): boolean {
    if (!existsSync(rollbackPath)) {
      return false
    }
    this.assertOwned(dirname(rollbackPath))
    this.assertOwned(rollbackPath)
    if (!lstatSync(rollbackPath).isFile()) {
      return false
    }
    try {
      const backup = this.parseState(readFileSync(rollbackPath, 'utf8'))
      return backup.accounts.some((account) => account.id.toLowerCase() === accountId.toLowerCase())
    } catch {
      return false
    }
  }

  private async retryBackups(providerRoot: string, registered: Set<string>): Promise<void> {
    const entries = await readdir(providerRoot, { withFileTypes: true })
    for (const entry of entries) {
      const accountId = /^accounts\.json\.(.+)\.rollback$/.exec(entry.name)?.[1]
      if (
        !entry.isFile() ||
        !accountId ||
        !z.uuid().safeParse(accountId).success ||
        registered.has(accountId.toLowerCase())
      ) {
        continue
      }
      const rollbackPath = join(providerRoot, entry.name)
      try {
        if (!this.hasRemovalBackup(rollbackPath, accountId)) {
          continue
        }
        const pendingDirectory = join(providerRoot, '.pending-delete', accountId)
        this.quarantine(join(providerRoot, accountId), pendingDirectory)
        this.discardBackup(rollbackPath)
      } catch {
        console.warn('[managed-data-accounts] Could not recover interrupted account removal.')
      }
    }
  }

  private discardBackup(rollbackPath: string): void {
    try {
      rmSync(rollbackPath, { force: true })
    } catch {
      console.warn('[managed-data-accounts] Could not remove account metadata backup.')
    }
  }

  private async cleanup(directory: string): Promise<void> {
    if (!existsSync(directory)) {
      return
    }
    try {
      this.assertOwned(dirname(directory))
      this.assertOwned(directory)
      await this.removeDirectory(directory)
    } catch {
      console.warn(
        '[managed-data-accounts] Account removed; private directory cleanup is deferred.'
      )
    }
  }

  async retry(provider: ManagedDataAccountProvider, registered: Set<string>): Promise<void> {
    const providerRoot = join(this.root, provider)
    if (!existsSync(providerRoot)) {
      return
    }
    try {
      this.assertOwned(providerRoot)
      // UUID case variants may name the same directory.
      const registeredIds = new Set([...registered].map((id) => id.toLowerCase()))
      await this.retryBackups(providerRoot, registeredIds)
      const pendingRoot = join(providerRoot, '.pending-delete')
      if (!existsSync(pendingRoot)) {
        return
      }
      this.assertOwned(pendingRoot)
      const entries = await readdir(pendingRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (
          !entry.isDirectory() ||
          !z.uuid().safeParse(entry.name).success ||
          registeredIds.has(entry.name.toLowerCase())
        ) {
          continue
        }
        await this.cleanup(join(pendingRoot, entry.name))
        if (!existsSync(join(providerRoot, entry.name))) {
          this.discardBackup(join(providerRoot, `accounts.json.${entry.name}.rollback`))
        }
      }
    } catch {
      console.warn('[managed-data-accounts] Could not retry private account directory cleanup.')
    }
  }
}
