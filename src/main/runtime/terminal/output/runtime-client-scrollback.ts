import { OrcaRuntimeWithMigrationCatalog } from '../../hosts/migration/runtime-migration-catalog'
import { daemonHistoryDirPath } from '../../../daemon/launch/daemon-launch-paths'
import { readHostTerminalHistory } from './host-terminal-history-read'
import type {
  SessionReadTerminalHistoryRequest,
  SessionReadTerminalHistoryResult
} from '../../../../shared/rpc-contract/session-terminal-history-params'
import type { SessionReadTerminalScrollbackResult } from '../../../../shared/rpc-contract/session-terminal-scrollback-params'
import {
  readHostTerminalScrollback,
  type HostTerminalScrollbackReadRequest
} from './host-terminal-scrollback-read'

export abstract class OrcaRuntimeWithClientTerminalScrollback extends OrcaRuntimeWithMigrationCatalog {
  async readTerminalHistoryForClient(
    request: SessionReadTerminalHistoryRequest,
    signal?: AbortSignal
  ): Promise<SessionReadTerminalHistoryResult> {
    const store = this.store
    const getWorkspaceSession = store?.getWorkspaceSession
    const getWorkspaceSessionHostIds = store?.getWorkspaceSessionHostIds
    if (!store || !getWorkspaceSession || !getWorkspaceSessionHostIds) {
      throw new Error('runtime_unavailable')
    }
    return readHostTerminalHistory(
      {
        getWorkspaceSession: (hostId) => getWorkspaceSession.call(store, hostId),
        getWorkspaceSessionHostIds: () => getWorkspaceSessionHostIds.call(store)
      },
      daemonHistoryDirPath(),
      request,
      signal
    )
  }

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
        getWorkspaceSession: (worktreeId) => this.workspaceSessions.get(worktreeId),
        statSnapshotSize: (ref) => statSnapshotSize.call(store, ref),
        readSnapshot: (ref) => readSnapshot.call(store, ref)
      },
      request
    )
  }
}
