import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { sanitizeWorkspaceSessionTerminalRetirements } from '../../runtime/mobile-session-terminal-persistence-retirement'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { setMigrationUnsupportedPty } from '../../agent-hooks/migration-unsupported-pty-state'
import { pruneWorkspaceSessionBrowserHistory } from '../../../shared/workspace-session-browser-history'
import { migrateWorkspaceSessionTerminalScrollbackSnapshots } from '../../terminal-scrollback-snapshots'
import {
  deleteRemovedTerminalScrollbackSnapshotsAsync,
  migrateWorkspaceSessionTerminalScrollbackSnapshotsAsync
} from '../../terminal-scrollback-snapshot-async-migration'
import { preserveRuntimeAuthoredWorkspaceSessionFields } from '../runtime-authored-workspace-session-fields'
import { registerPersistedPaneKeyAlias } from '../restoring-sessions/pane-alias-normalization'
import {
  normalizeWorkspaceSessionPaneIdentities,
  remapAcknowledgedAgentPaneKeys,
  remapActivityClearedAtPaneKeys,
  remapManuallyUnreadTurnPaneKeys,
  remapSshRemotePtyLeaseLeafIds,
  type WorkspaceSessionPaneIdentityRemap
} from '../restoring-sessions/workspace-pane-normalization'
import { deleteRemovedTerminalScrollbackSnapshots } from './terminal-session-cleanup'
import { preserveMissingWorkspaceSessionTerminalBindings } from './workspace-session-terminal-binding-replay'
import {
  getSessionSnapshotOperationsContext,
  type SessionSnapshotOperations
} from './session-snapshot-operations'
import { scheduleSave } from './write-scheduling'
import {
  collectOrcadRetirementSnapshotRefs,
  reconcileOrcadRetirementSessionWrite
} from './orcad-retirement-session-write'

export function setLocalWorkspaceSession(
  owner: SessionSnapshotOperations,
  session: PersistedState['workspaceSession'],
  deferSnapshotFiles = false
): void {
  const context = getSessionSnapshotOperationsContext(owner)
  const prior = context.runtime.state.workspaceSession
  session = reconcileOrcadRetirementSessionWrite(context.runtime, session, LOCAL_EXECUTION_HOST_ID)
  // Why here and not at the callers: the before-unload stage path writes the renderer's payload
  // straight through, so a per-caller guard leaves the quit write erasing runtime-authored rows.
  session = preserveRuntimeAuthoredWorkspaceSessionFields(session, prior)
  session = sanitizeWorkspaceSessionTerminalRetirements(session, prior)
  session = pruneWorkspaceSessionBrowserHistory(
    context.runtime.transferSnapshotHistory.prune(session, context.runtime.state.repos, prior)
  )

  // Why (Issue #217): merge existing bindings when the incoming binding is empty, so a stale pre-spawn snapshot can't overwrite the durable PTY binding.
  const normalized = normalizeWorkspaceSessionPaneIdentities(session, prior?.terminalLayoutsByTabId)
  for (const entry of normalized.migrationUnsupportedEntries) {
    setMigrationUnsupportedPty(entry)
  }
  const remappedAcknowledgements = remapAcknowledgedAgentPaneKeys(
    context.runtime.state.ui?.acknowledgedAgentsByPaneKey,
    normalized.leafIdByInputLeafIdByTabId
  )
  const remappedActivityCutoffs = remapActivityClearedAtPaneKeys(
    context.runtime.state.ui?.activityClearedAtByPaneKey,
    normalized.leafIdByInputLeafIdByTabId
  )
  const remappedManualUnread = remapManuallyUnreadTurnPaneKeys(
    context.runtime.state.ui?.manuallyUnreadTurnsByPaneKey,
    normalized.leafIdByInputLeafIdByTabId
  )
  if (
    remappedAcknowledgements.changed ||
    remappedActivityCutoffs.changed ||
    remappedManualUnread.changed
  ) {
    context.runtime.state.ui = {
      ...context.runtime.state.ui,
      ...(remappedAcknowledgements.changed
        ? { acknowledgedAgentsByPaneKey: remappedAcknowledgements.acknowledgements }
        : {}),
      ...(remappedActivityCutoffs.changed
        ? { activityClearedAtByPaneKey: remappedActivityCutoffs.cutoffs }
        : {}),
      ...(remappedManualUnread.changed
        ? { manuallyUnreadTurnsByPaneKey: remappedManualUnread.turns }
        : {})
    }
  }
  for (const entry of normalized.legacyPaneKeyAliasEntries) {
    registerPersistedPaneKeyAlias(entry)
  }
  session = normalized.session
  const remapsByHostId = new Map<ExecutionHostId, WorkspaceSessionPaneIdentityRemap>([
    [LOCAL_EXECUTION_HOST_ID, normalized]
  ])
  const remappedLeases = remapSshRemotePtyLeaseLeafIds(
    context.runtime.state.sshRemotePtyLeases ?? [],
    remapsByHostId,
    new Set(context.sessions.getWorkspaceSessionHostIds())
  )
  if (remappedLeases.changed) {
    context.runtime.state.sshRemotePtyLeases = remappedLeases.leases
  }
  session = preserveMissingWorkspaceSessionTerminalBindings(session, prior, context.bindingRecovery)
  session = context.runtime.transferSnapshotHistory.prune(
    session,
    context.runtime.state.repos,
    prior
  )
  if (!deferSnapshotFiles) {
    const migratedScrollback = migrateWorkspaceSessionTerminalScrollbackSnapshots(
      session,
      context.runtime.terminalScrollbackSnapshotStorage
    )
    session = migratedScrollback.session
    deleteRemovedTerminalScrollbackSnapshots(
      prior,
      session,
      context.runtime.terminalScrollbackSnapshotStorage,
      collectOrcadRetirementSnapshotRefs(context.runtime)
    )
  }
  context.runtime.state.workspaceSession = session
  if (deferSnapshotFiles) {
    enqueueTerminalScrollbackSnapshotWork(owner, prior, session)
  }
  scheduleSave(context.scheduling)
}

export function enqueueTerminalScrollbackSnapshotWork(
  owner: SessionSnapshotOperations,
  prior: WorkspaceSessionState | undefined,
  staged: WorkspaceSessionState
): void {
  const context = getSessionSnapshotOperationsContext(owner)
  const previous = context.runtime.pendingSnapshotFileWork ?? Promise.resolve()
  const work = previous
    .then(async () => {
      if (context.runtime.state.workspaceSession !== staged) {
        if (context.runtime.state.workspaceSession) {
          await deleteRemovedTerminalScrollbackSnapshotsAsync(
            prior,
            context.runtime.state.workspaceSession,
            context.runtime.terminalScrollbackSnapshotStorage,
            collectOrcadRetirementSnapshotRefs(context.runtime)
          )
        }
        return
      }
      const admitted = reconcileOrcadRetirementSessionWrite(
        context.runtime,
        staged,
        LOCAL_EXECUTION_HOST_ID
      )
      const migrated = await migrateWorkspaceSessionTerminalScrollbackSnapshotsAsync(
        admitted,
        context.runtime.terminalScrollbackSnapshotStorage
      )
      let current =
        context.runtime.state.workspaceSession === staged
          ? migrated
          : context.runtime.state.workspaceSession
      if (context.runtime.state.workspaceSession === staged) {
        context.runtime.state.workspaceSession = reconcileOrcadRetirementSessionWrite(
          context.runtime,
          migrated,
          LOCAL_EXECUTION_HOST_ID
        )
        current = context.runtime.state.workspaceSession
      } else if (current) {
        await deleteRemovedTerminalScrollbackSnapshotsAsync(
          migrated,
          current,
          context.runtime.terminalScrollbackSnapshotStorage,
          collectOrcadRetirementSnapshotRefs(context.runtime)
        )
      }
      if (current) {
        await deleteRemovedTerminalScrollbackSnapshotsAsync(
          prior,
          current,
          context.runtime.terminalScrollbackSnapshotStorage,
          collectOrcadRetirementSnapshotRefs(context.runtime)
        )
      }
    })
    .catch((error) => {
      console.error('[terminal-scrollback] Failed to prepare unload snapshots:', error)
    })
    .finally(() => {
      if (context.runtime.pendingSnapshotFileWork === work) {
        context.runtime.pendingSnapshotFileWork = null
      }
    })
  context.runtime.pendingSnapshotFileWork = work
}
