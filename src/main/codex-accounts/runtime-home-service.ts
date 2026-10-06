import { assertCodexProfileConfigAuthority } from './profile-config-authority'
import { readManagedCodexProfileIdentity } from './independent-profile-home'
import {
  syncSystemCodexResourcesIntoManagedHome,
  getSystemCodexHomePath
} from '../codex/codex-home-paths'
import { getCodexConfigSyncStatus } from '../codex/config-sync-stall'
import { syncSystemConfigIntoManagedCodexHome } from '../codex/codex-config-mirror'
import type { Store } from '../persistence'
import { CodexRuntimeHomeAuthSync } from './runtime-home-service-auth-sync'

export type {
  CodexMirroredHomeStatus,
  CodexRateLimitHomeResolution
} from './runtime-home-service-types'

export class CodexRuntimeHomeService extends CodexRuntimeHomeAuthSync {
  async prepareForCodexProfileLaunch(accountId: string): Promise<string> {
    const account = this.store
      .getSettings()
      .codexManagedAccounts.find((entry) => entry.id === accountId)
    if (
      process.platform === 'win32' ||
      !account ||
      account.managedHomeRuntime === 'wsl' ||
      this.getWslManagedHomePath(account)
    ) {
      throw new Error('A local managed Codex account is required.')
    }
    const resolved = this.resolveCodexManagedAccountHomeForInactiveFetch(account)
    if (resolved.kind !== 'ready') {
      throw new Error('Managed Codex home is untrusted or unavailable.')
    }
    const home = resolved.homePath
    readManagedCodexProfileIdentity(home, account)
    assertCodexProfileConfigAuthority(getSystemCodexHomePath())
    assertCodexProfileConfigAuthority(home)
    syncSystemCodexResourcesIntoManagedHome(home)
    const homes = { runtimeHomePath: home, systemHomePath: getSystemCodexHomePath() }
    syncSystemConfigIntoManagedCodexHome(homes)
    if (getCodexConfigSyncStatus(homes).state === 'stalled') {
      throw new Error('Managed Codex configuration is unavailable.')
    }
    assertCodexProfileConfigAuthority(home)
    readManagedCodexProfileIdentity(home, account)
    return home
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
