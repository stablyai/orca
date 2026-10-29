import type { PersistedState } from '../../../shared/persisted-state-types'

import type { SessionUnitReader, SessionUnitSelection } from '../../../shared/session-unit-reader'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

import { normalizeBrowserHistoryEntries } from '../../../shared/workspace-session-browser-history'

import {
  isWslMoveWorkspaceSessionFrozen,
  isWslMoveWorkspaceHostOwned
} from '../moving-wsl-projects/wsl-move-scope-guard'
import { hostOwnedChatOwnerRows } from '../moving-wsl-projects/wsl-move-host-owned-chat-tabs'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../shared/workspace-scope'
import type { SessionUnitAddress } from '../../../shared/session-unit-index'
import {
  type normalizeSessionPaneUnits,
  remapAcknowledgedAgentPaneKeys,
  remapActivityClearedAtPaneKeys,
  remapManuallyUnreadTurnPaneKeys,
  remapSshRemotePtyLeaseLeafIds
} from '../restoring-sessions/workspace-pane-normalization'

export function normalizeSnapshotHistory(reader: SessionUnitReader): void {
  if (!reader.touches('browserUrlHistory')) {
    return
  }
  const history = reader.field('browserUrlHistory').value
  if (!history) {
    return
  }
  const next = normalizeBrowserHistoryEntries(history)
  if (next.length !== history.length || next.some((value, index) => value !== history[index])) {
    reader.replace('browserUrlHistory', { present: true, value: next })
  }
}

export function keepFrozenSnapshotUnits(
  reader: SessionUnitReader,
  selection: SessionUnitSelection
): void {
  const chats = new Map<string, ReturnType<typeof hostOwnedChatOwnerRows>>()
  const protectedUnits: SessionUnitAddress[] = []
  for (const [field, keys] of selection) {
    for (const key of keys) {
      const frozenOwners = new Set(
        [reader.dataOwner(field, key, 'prior'), reader.dataOwner(field, key)]
          .filter((owner): owner is string => owner != null)
          .map(normalizeWorkspaceSessionKeyToWorkspaceId)
          .filter(isWslMoveWorkspaceSessionFrozen)
      )
      if (!frozenOwners.size) {
        continue
      }
      protectedUnits.push({ field, key })
      for (const owner of frozenOwners) {
        if (!chats.has(owner) && isWslMoveWorkspaceHostOwned(owner)) {
          chats.set(
            owner,
            hostOwnedChatOwnerRows(
              {
                tabs: reader.unit('unifiedTabs', owner, 'prior').value,
                groups: reader.unit('tabGroups', owner, 'prior').value
              },
              {
                tabs: reader.unit('unifiedTabs', owner).value,
                groups: reader.unit('tabGroups', owner).value,
                layout: reader.unit('tabGroupLayouts', owner).value
              }
            )
          )
        }
      }
    }
  }
  for (const { field, key } of protectedUnits) {
    reader.write(field, key, reader.unit(field, key, 'prior'))
  }
  for (const [owner, rows] of chats) {
    if (!rows) {
      continue
    }
    reader.write('unifiedTabs', owner, { present: true, value: rows.tabs })
    reader.write('tabGroups', owner, { present: true, value: rows.groups })
    if (rows.layout) {
      reader.write('tabGroupLayouts', owner, { present: true, value: rows.layout })
    }
  }
  if (reader.touches('activeWorktreeIdsOnShutdown')) {
    const next = reader.field('activeWorktreeIdsOnShutdown')
    const prior = reader.field('activeWorktreeIdsOnShutdown', 'prior')
    const kept = (prior.value ?? []).filter(isWslMoveWorkspaceSessionFrozen)
    const removed = (next.value ?? []).some(isWslMoveWorkspaceSessionFrozen)
    if (kept.length || removed) {
      reader.replace('activeWorktreeIdsOnShutdown', {
        present: true,
        value: [
          ...(next.value ?? []).filter((owner) => !isWslMoveWorkspaceSessionFrozen(owner)),
          ...kept
        ]
      })
    }
  }
}

export function preparePaneRemapEffects(
  state: PersistedState,
  normalized: ReturnType<typeof normalizeSessionPaneUnits>,
  hostId: ExecutionHostId,
  tabs: ReadonlySet<string>,
  full: boolean
) {
  const ack = remapAcknowledgedAgentPaneKeys(
    state.ui?.acknowledgedAgentsByPaneKey,
    normalized.leafIdByInputLeafIdByTabId
  )
  const activity = remapActivityClearedAtPaneKeys(
    state.ui?.activityClearedAtByPaneKey,
    normalized.leafIdByInputLeafIdByTabId
  )
  const unread = remapManuallyUnreadTurnPaneKeys(
    state.ui?.manuallyUnreadTurnsByPaneKey,
    normalized.leafIdByInputLeafIdByTabId
  )
  const ui =
    ack.changed || activity.changed || unread.changed
      ? {
          ...state.ui,
          ...(ack.changed ? { acknowledgedAgentsByPaneKey: ack.acknowledgements } : {}),
          ...(activity.changed ? { activityClearedAtByPaneKey: activity.cutoffs } : {}),
          ...(unread.changed ? { manuallyUnreadTurnsByPaneKey: unread.turns } : {})
        }
      : undefined
  const leases = remapSshRemotePtyLeaseLeafIds(
    state.sshRemotePtyLeases ?? [],
    new Map([[hostId, normalized]]),
    new Set([
      LOCAL_EXECUTION_HOST_ID,
      ...Object.keys(state.workspaceSessionsByHostId ?? {}).filter(
        (key): key is ExecutionHostId => parseExecutionHostId(key) !== null
      )
    ]),
    full ? undefined : tabs
  )
  return { ui, leases: leases.changed ? leases.leases : undefined }
}
