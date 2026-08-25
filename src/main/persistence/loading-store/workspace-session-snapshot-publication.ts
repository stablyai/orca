import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { sanitizeWorkspaceSessionTerminalRetirements } from '../../runtime/mobile-session-terminal-persistence-retirement'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { setMigrationUnsupportedPty } from '../../agent-hooks/migration-unsupported-pty-state'
import { pruneLocalTerminalScrollbackBuffers } from '../../../shared/workspace-session-terminal-buffers'
import { pruneWorkspaceSessionBrowserHistory } from '../../../shared/workspace-session-browser-history'
import { migrateWorkspaceSessionTerminalScrollbackSnapshots } from '../../terminal-scrollback-snapshots'
import {
  deleteRemovedTerminalScrollbackSnapshotsAsync,
  migrateWorkspaceSessionTerminalScrollbackSnapshotsAsync
} from '../../terminal-scrollback-snapshot-async-migration'
import { preserveMissingLeafRecordEntries } from '../restoring-sessions/terminal-layout-normalization'
import { registerPersistedPaneKeyAlias } from '../restoring-sessions/pane-alias-normalization'
import {
  normalizeWorkspaceSessionPaneIdentities,
  remapAcknowledgedAgentPaneKeys,
  remapSshRemotePtyLeaseLeafIds,
  type WorkspaceSessionPaneIdentityRemap
} from '../restoring-sessions/workspace-pane-normalization'
import { deleteRemovedTerminalScrollbackSnapshots } from './terminal-session-cleanup'
import {
  getSessionSnapshotOperationsContext,
  type SessionSnapshotOperations
} from './session-snapshot-operations'
import { scheduleSave } from './write-scheduling'

export function setLocalWorkspaceSession(
  owner: SessionSnapshotOperations,
  session: PersistedState['workspaceSession'],
  deferSnapshotFiles = false
): void {
  const context = getSessionSnapshotOperationsContext(owner)
  const prior = context.runtime.state.workspaceSession
  session = sanitizeWorkspaceSessionTerminalRetirements(session, prior)
  session = pruneWorkspaceSessionBrowserHistory(
    pruneLocalTerminalScrollbackBuffers(session, context.runtime.state.repos)
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
  if (remappedAcknowledgements.changed) {
    context.runtime.state.ui = {
      ...context.runtime.state.ui,
      acknowledgedAgentsByPaneKey: remappedAcknowledgements.acknowledgements
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
  if (session && prior) {
    const priorTabs = prior.tabsByWorktree ?? {}
    const nextTabs = session.tabsByWorktree ?? {}
    const worktreeIdByTabId = new Map<string, string>()
    for (const [worktreeId, tabs] of Object.entries({ ...priorTabs, ...nextTabs })) {
      for (const tab of tabs) {
        worktreeIdByTabId.set(tab.id, worktreeId)
      }
    }
    for (const [worktreeId, tabs] of Object.entries(nextTabs)) {
      const priorList = priorTabs[worktreeId]
      if (!priorList) {
        continue
      }
      for (const tab of tabs) {
        if (tab.ptyId) {
          continue
        }
        const priorTab = priorList.find((t) => t.id === tab.id)
        if (
          priorTab?.ptyId &&
          context.bindingRecovery.isRestorablePtyBinding({
            ptyId: priorTab.ptyId,
            worktreeId,
            targetId: context.bindingRecovery.getConnectionIdForWorktree(worktreeId),
            tabId: tab.id
          })
        ) {
          tab.ptyId = priorTab.ptyId
        }
      }
    }
    const priorLayouts = prior.terminalLayoutsByTabId ?? {}
    const nextLayouts = session.terminalLayoutsByTabId ?? {}
    for (const [tabId, layout] of Object.entries(nextLayouts)) {
      const priorLayout = priorLayouts[tabId]
      if (!priorLayout?.ptyIdsByLeafId) {
        continue
      }
      const incoming = layout.ptyIdsByLeafId ?? {}
      const incomingHasAnyBinding = Object.keys(incoming).length > 0
      const liveLeafIds = context.bindingRecovery.getTerminalLayoutLeafIds(layout.root)
      const worktreeId = worktreeIdByTabId.get(tabId)
      const targetId = worktreeId
        ? context.bindingRecovery.getConnectionIdForWorktree(worktreeId)
        : null
      const restorableBindings = Object.fromEntries(
        Object.entries(priorLayout.ptyIdsByLeafId).filter(
          ([leafId, ptyId]) =>
            liveLeafIds.has(leafId) &&
            incoming[leafId] === undefined &&
            // Why: an empty layout map may be a stale pre-spawn snapshot; a partial map is intentional unless a durable SSH lease proves it.
            (incomingHasAnyBinding
              ? context.bindingRecovery.hasRestorableSshRemotePtyLease({
                  ptyId,
                  targetId,
                  worktreeId,
                  tabId,
                  leafId
                })
              : context.bindingRecovery.isRestorablePtyBinding({
                  ptyId,
                  targetId,
                  worktreeId,
                  tabId,
                  leafId
                }))
        )
      )
      if (Object.keys(restorableBindings).length > 0) {
        layout.ptyIdsByLeafId = { ...restorableBindings, ...incoming }
        // Why: the same stale write that drops ptyIdsByLeafId may come from an older renderer lacking UUID-keyed metadata.
        const buffersByLeafId = preserveMissingLeafRecordEntries(
          priorLayout.buffersByLeafId,
          layout.buffersByLeafId,
          liveLeafIds
        )
        const scrollbackRefsByLeafId = preserveMissingLeafRecordEntries(
          priorLayout.scrollbackRefsByLeafId,
          layout.scrollbackRefsByLeafId,
          liveLeafIds
        )
        const titlesByLeafId = preserveMissingLeafRecordEntries(
          priorLayout.titlesByLeafId,
          layout.titlesByLeafId,
          liveLeafIds
        )
        if (buffersByLeafId) {
          layout.buffersByLeafId = buffersByLeafId
        }
        if (scrollbackRefsByLeafId) {
          layout.scrollbackRefsByLeafId = scrollbackRefsByLeafId
        }
        if (titlesByLeafId) {
          layout.titlesByLeafId = titlesByLeafId
        }
      }
    }
  }
  session = pruneLocalTerminalScrollbackBuffers(session, context.runtime.state.repos)
  if (!deferSnapshotFiles) {
    const migratedScrollback = migrateWorkspaceSessionTerminalScrollbackSnapshots(
      session,
      context.runtime.terminalScrollbackSnapshotStorage
    )
    session = migratedScrollback.session
    deleteRemovedTerminalScrollbackSnapshots(
      prior,
      session,
      context.runtime.terminalScrollbackSnapshotStorage
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
            context.runtime.terminalScrollbackSnapshotStorage
          )
        }
        return
      }
      const migrated = await migrateWorkspaceSessionTerminalScrollbackSnapshotsAsync(
        staged,
        context.runtime.terminalScrollbackSnapshotStorage
      )
      const current =
        context.runtime.state.workspaceSession === staged
          ? migrated
          : context.runtime.state.workspaceSession
      if (context.runtime.state.workspaceSession === staged) {
        context.runtime.state.workspaceSession = migrated
      } else if (current) {
        await deleteRemovedTerminalScrollbackSnapshotsAsync(
          migrated,
          current,
          context.runtime.terminalScrollbackSnapshotStorage
        )
      }
      if (current) {
        await deleteRemovedTerminalScrollbackSnapshotsAsync(
          prior,
          current,
          context.runtime.terminalScrollbackSnapshotStorage
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
