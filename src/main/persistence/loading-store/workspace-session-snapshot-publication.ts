import {
  normalizeSnapshotHistory,
  keepFrozenSnapshotUnits,
  preparePaneRemapEffects
} from './session-snapshot-normalization-effects'
export { keepFrozenSnapshotUnits } from './session-snapshot-normalization-effects'
import { setMigrationUnsupportedPty } from '../../agent-hooks/migration-unsupported-pty-state'
import { registerPersistedPaneKeyAlias } from '../restoring-sessions/pane-alias-normalization'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { SessionUnitReader, selectSessionUnits } from '../../../shared/session-unit-reader'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { reduceTerminalScrollbackBuffers } from '../../../shared/workspace-session-terminal-buffers'

import { migrateTerminalLayoutScrollbackSnapshots } from '../../terminal-scrollback-snapshot-layout-migration'
import { migrateWorkspaceSessionTerminalScrollbackSnapshotsAsync } from '../../terminal-scrollback-snapshot-async-migration'
import { reduceRuntimeAuthoredSessionFields } from '../runtime-authored-workspace-session-fields'
import { reduceClosedTerminalTabFence } from '../closed-terminal-tab-write-fence'
import { reduceSessionTerminalRetirements } from '../../runtime/mobile-session-terminal-persistence-retirement'

import { normalizeSessionPaneUnits } from '../restoring-sessions/workspace-pane-normalization'
import {
  reduceMissingSessionTerminalBindings,
  sshTargetIdForWorkspaceSessionHost
} from './workspace-session-terminal-binding-replay'
import {
  getSessionSnapshotOperationsContext,
  type SessionSnapshotOperations
} from './session-snapshot-operations'
import { scheduleSave, type WriteSchedulingOperations } from './write-scheduling'
import type { StoreRuntimeState } from './store-runtime-state'
import type { TerminalBindingRecoveryOperations } from './terminal-binding-recovery'
import { reduceTerminalRowOrder } from '../../../shared/workspace-layout/terminal-row-order'
import { HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS } from '../../../shared/workspace-session-host-field-ownership'
import { publishSessionChanges, sessionPublication } from './session-publication'
import { sessionNormalizationRepos } from './session-normalization-catalog'
import { runtimePartitionFenceRevisions } from './runtime-partition-topology-fence'

type SnapshotContext = {
  runtime: Pick<StoreRuntimeState, 'state' | 'terminalScrollbackSnapshotStorage'>
  scheduling: WriteSchedulingOperations
  bindingRecovery: TerminalBindingRecoveryOperations
}

export function setLocalWorkspaceSession(
  owner: SessionSnapshotOperations,
  session: PersistedState['workspaceSession'],
  deferSnapshotFiles = false
): void {
  const context = getSessionSnapshotOperationsContext(owner)
  const { root, index } = sessionPublication(context.runtime.state).partition(
    LOCAL_EXECUTION_HOST_ID
  )
  const reader = SessionUnitReader.between(root, session, index)
  publishWorkspaceSessionSnapshot(
    context,
    LOCAL_EXECUTION_HOST_ID,
    reader,
    true,
    deferSnapshotFiles
  )
  if (deferSnapshotFiles) {
    enqueueTerminalScrollbackSnapshotWork(owner, root, reader.snapshot())
  }
}

/** The same ordered stages serve full ingress and selected edits over actual values. */
export function publishWorkspaceSessionSnapshot(
  context: SnapshotContext,
  hostId: ExecutionHostId,
  reader: SessionUnitReader,
  full: boolean,
  deferSnapshotFiles = false,
  selection = selectSessionUnits(reader, [], full),
  normalizeTopology = true
): void {
  const { state } = context.runtime
  const local = hostId === LOCAL_EXECUTION_HOST_ID
  const owners = reader.affectedOwners(selection)
  if (local) {
    keepFrozenSnapshotUnits(reader, selection)
  }
  reader.admitFields(true)
  const panes = new Set([
    ...(selection.get('terminalPtyIncarnationsByPaneKey') ?? []),
    ...(selection.get('sleepingAgentSessionsByPaneKey') ?? [])
  ])
  if (normalizeTopology) {
    reduceRuntimeAuthoredSessionFields(reader, owners, panes)
  }
  if (normalizeTopology || reader.touches('unifiedTabs')) {
    reduceClosedTerminalTabFence(reader, selection.get('closedTerminalTabTombstonesByTabId') ?? [])
  }
  if (normalizeTopology) {
    const revisions = runtimePartitionFenceRevisions(
      context.runtime,
      hostId,
      reader,
      selection.get('terminalTopologyRevisionByRepoId') ?? [],
      selection.get('terminalSurfaceTombstonesByPaneKey') ?? []
    )
    reduceSessionTerminalRetirements(reader, selection, revisions)
  }
  const tabs = new Set([
    ...(selection.get('terminalLayoutsByTabId') ?? []),
    ...(selection.get('localOnlyScrollbackByTabId') ?? [])
  ])
  const repos = new Map(
    sessionNormalizationRepos(state.repos, selection).map((repo) => [repo.id, repo])
  )
  let normalized: ReturnType<typeof normalizeSessionPaneUnits> | undefined
  normalizeSnapshotHistory(reader)
  if (local && normalizeTopology) {
    reduceTerminalScrollbackBuffers(reader, tabs, repos)
    normalized = normalizeSessionPaneUnits(reader, tabs, { registerAliases: false })
  }
  if (normalizeTopology) {
    reduceMissingSessionTerminalBindings(
      reader,
      owners,
      tabs,
      context.bindingRecovery,
      local
        ? {}
        : {
            executionHostId: hostId,
            targetIdForWorktree: sshTargetIdForWorkspaceSessionHost(hostId)
          }
    )
    reduceTerminalScrollbackBuffers(reader, tabs, repos)
    if (!local) {
      for (const field of HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS) {
        if (state.workspaceSession[field] !== undefined) {
          reader.replace(field, { present: false, value: undefined })
        }
      }
    }
  }
  // File writes finish before the root can point at their refs.
  if (local && normalizeTopology && !deferSnapshotFiles) {
    for (const tabId of tabs) {
      const layout = reader.unit('terminalLayoutsByTabId', tabId).value
      if (layout) {
        reader.write('terminalLayoutsByTabId', tabId, {
          present: true,
          value: migrateTerminalLayoutScrollbackSnapshots(
            tabId,
            layout,
            context.runtime.terminalScrollbackSnapshotStorage
          )
        })
      }
    }
  }
  reduceTerminalRowOrder(reader, owners)
  const effects = normalized
    ? preparePaneRemapEffects(state, normalized, hostId, tabs, full)
    : undefined
  const publicationEffects: (() => void)[] = []
  for (const entry of normalized?.migrationUnsupportedEntries ?? []) {
    publicationEffects.push(() => setMigrationUnsupportedPty(entry))
  }
  for (const entry of normalized?.legacyPaneKeyAliasEntries ?? []) {
    publicationEffects.push(() => registerPersistedPaneKeyAlias(entry))
  }
  const ui = effects?.ui,
    leases = effects?.leases
  if (ui) {
    publicationEffects.push(() => {
      state.ui = ui
    })
  }
  if (leases) {
    publicationEffects.push(() => {
      state.sshRemotePtyLeases = leases
    })
  }
  publishSessionChanges(
    state,
    hostId,
    reader.prepare({
      kind: full ? 'fullReplacement' : 'renderer',
      fullReplacement: full,
      effects: publicationEffects
    })
  )
  const domain = local ? 'workspaceSession' : 'workspaceSessionsByHostId'
  scheduleSave(
    context.scheduling,
    effects?.ui ? undefined : effects?.leases ? [domain, 'sshRemotePtyLeases'] : [domain],
    hostId
  )
}

export function enqueueTerminalScrollbackSnapshotWork(
  owner: SessionSnapshotOperations,
  _prior: WorkspaceSessionState | undefined,
  staged: WorkspaceSessionState
): void {
  const context = getSessionSnapshotOperationsContext(owner)
  const publication = sessionPublication(context.runtime.state)
  const versions = new Map(
    Object.keys(staged.terminalLayoutsByTabId).map((tabId) => [
      tabId,
      publication.version(LOCAL_EXECUTION_HOST_ID, 'terminalLayoutsByTabId', tabId)
    ])
  )
  const previous = context.runtime.pendingSnapshotFileWork ?? Promise.resolve()
  const work = previous
    .then(async () => {
      await migrateWorkspaceSessionTerminalScrollbackSnapshotsAsync(
        staged,
        context.runtime.terminalScrollbackSnapshotStorage,
        (tabId, commit) => {
          if (
            publication.version(LOCAL_EXECUTION_HOST_ID, 'terminalLayoutsByTabId', tabId) !==
            versions.get(tabId)
          ) {
            return
          }
          const layout = commit()
          const { root, index } = publication.partition(LOCAL_EXECUTION_HOST_ID)
          const prepared = new SessionUnitReader(root, index)
          prepared.write('terminalLayoutsByTabId', tabId, { present: true, value: layout })
          publishSessionChanges(
            context.runtime.state,
            LOCAL_EXECUTION_HOST_ID,
            prepared.prepare({ kind: 'authoritative' })
          )
          scheduleSave(context.scheduling, ['workspaceSession'], LOCAL_EXECUTION_HOST_ID)
        }
      )
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
