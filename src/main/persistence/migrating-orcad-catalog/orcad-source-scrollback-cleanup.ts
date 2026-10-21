import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import {
  collectTerminalScrollbackSnapshotRefs,
  deleteTerminalScrollbackSnapshotSync
} from '../../terminal-scrollback-snapshots'
import { sessionPartitions } from './orcad-source-workspace-session-fragments'

/** Deletes the given snapshot files unless a session or a pending export still names them. */
export function deleteUnreferencedOrcadMigrationScrollback(
  runtime: Pick<
    StoreRuntimeState,
    'state' | 'terminalScrollbackSnapshotStorage' | 'retainedScrollbackRefsByMigrationId'
  >,
  refs: Iterable<string>
): void {
  const live = new Set([
    ...sessionPartitions(runtime.state, LOCAL_EXECUTION_HOST_ID).flatMap(([, session]) => [
      ...collectTerminalScrollbackSnapshotRefs(session)
    ]),
    ...[...runtime.retainedScrollbackRefsByMigrationId.values()].flatMap((retained) => [
      ...retained
    ])
  ])
  for (const ref of refs) {
    if (!live.has(ref)) {
      deleteTerminalScrollbackSnapshotSync(ref, runtime.terminalScrollbackSnapshotStorage)
    }
  }
}
