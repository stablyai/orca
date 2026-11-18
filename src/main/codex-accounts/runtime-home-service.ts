import type { Store } from '../persistence/loading-store/store'
import { CodexRuntimeHomeAuthSync } from './runtime-home/credentials/runtime-home-service-auth-sync'
import { mkdir } from 'node:fs/promises'
import { getSystemCodexHomePath } from '../codex/configuration/homes/codex-home-paths'
import { prepareAccountHomeInWorker } from '../providers/accounts/account-home-preparation-worker'

export class CodexRuntimeHomeService extends CodexRuntimeHomeAuthSync {
  async prepareHistoryAccountHome(accountId: string | null): Promise<string> {
    if (accountId === null) {
      const home = getSystemCodexHomePath()
      await mkdir(home, { recursive: true })
      return home
    }
    const account = this.store
      .getSettings()
      .codexManagedAccounts.find((entry) => entry.id === accountId)
    if (!account || account.managedHomeRuntime === 'wsl') {
      throw new Error('This Codex account is unavailable on this host.')
    }
    const resolved = this.resolveCodexManagedAccountHomeForInactiveFetch(account)
    if (resolved.kind !== 'ready') {
      throw new Error('This Codex account home is unavailable. Sign in again.')
    }
    await prepareAccountHomeInWorker({
      kind: 'codex-config',
      homePath: resolved.homePath,
      systemHomePath: getSystemCodexHomePath()
    })
    return resolved.homePath
  }
  constructor(store: Store) {
    super(store)
    this.safeRecoverInterruptedRuntimeAuthOperation()
    this.safeMigrateLegacySharedAuth()
    this.safeMigrateLegacyManagedState()
    this.safeMigrateLegacyActiveHomePointer()
    this.initializeLastSyncedState()
    this.safeSyncForCurrentSelection()
  }
}
