import type { Store } from '../persistence/loading-store/store'
import { CodexRuntimeHomeAuthSync } from './runtime-home/credentials/runtime-home-service-auth-sync'

export class CodexRuntimeHomeService extends CodexRuntimeHomeAuthSync {
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
