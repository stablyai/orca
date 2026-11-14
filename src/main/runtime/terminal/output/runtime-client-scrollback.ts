import { OrcaRuntimeWithMigrationCatalog } from '../../hosts/migration/runtime-migration-catalog'
import type { SessionReadTerminalScrollbackResult } from '../../../../shared/rpc-contract/session-tabs/session-terminal-scrollback-params'
import {
  readHostTerminalScrollback,
  type HostTerminalScrollbackReadRequest
} from './host-terminal-scrollback-read'

export abstract class OrcaRuntimeWithClientTerminalScrollback extends OrcaRuntimeWithMigrationCatalog {
  /** A migrated pane's stored scrollback, for a client whose own copy is gone or never existed. */
  async readTerminalScrollbackForClient(
    request: HostTerminalScrollbackReadRequest
  ): Promise<SessionReadTerminalScrollbackResult> {
    const store = this.store
    const readSnapshot = store?.readTerminalScrollbackSnapshotAsync
    const statSnapshotSize = store?.statTerminalScrollbackSnapshotSize
    if (!store || !readSnapshot || !statSnapshotSize) {
      throw new Error('runtime_unavailable')
    }
    return readHostTerminalScrollback(
      {
        resolveWorktreeId: async (selector) => (await this.resolveWorkspaceSelector(selector)).id,
        getWorkspaceSession: (worktreeId) => this.workspaceSessions.borrow(worktreeId),
        statSnapshotSize: (ref) => statSnapshotSize.call(store, ref),
        readSnapshot: (ref) => readSnapshot.call(store, ref)
      },
      request
    )
  }
}
