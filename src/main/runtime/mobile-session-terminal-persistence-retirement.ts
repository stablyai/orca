import { SessionUnitIndex } from '../../shared/session-unit-index'
import {
  SessionUnitReader,
  selectSessionUnits,
  type SessionUnitSelection
} from '../../shared/session-unit-reader'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { WorkspaceVisibleTabType } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  pruneTabGroupLayoutAfterRetirement,
  repairMobileSessionTabGroupsAfterRetirement,
  type RetiredTerminalSurface
} from './mobile-session-terminal-retirement'
import { retireLeavesFromTerminalLayout } from '../../shared/terminal-layout-leaf-retirement'
import {
  reduceSessionTerminalMembership,
  reduceSessionIncarnationMembership
} from './workspace-session-terminal-membership-authority'
import { getDefaultWorkspaceSession } from '../../shared/constants'

function visibleTypeForContentType(
  contentType: string | undefined
): WorkspaceVisibleTabType | undefined {
  if (contentType === 'terminal') {
    return 'terminal'
  }
  if (contentType === 'browser') {
    return 'browser'
  }
  if (contentType === 'simulator') {
    return 'simulator'
  }
  return contentType ? 'editor' : undefined
}

function layoutContainsLeaf(
  node: WorkspaceSessionState['terminalLayoutsByTabId'][string]['root'],
  leafId: string
): boolean {
  if (!node) {
    return false
  }
  return node.type === 'leaf'
    ? node.leafId === leafId
    : layoutContainsLeaf(node.first, leafId) || layoutContainsLeaf(node.second, leafId)
}

function recordTerminalSurfaceRetirement(
  reader: SessionUnitReader,
  surface: RetiredTerminalSurface,
  paneKey: string
): void {
  for (const field of [
    'terminalPtyIncarnationsByPaneKey',
    'terminalSurfaceTombstonesByPaneKey'
  ] as const) {
    if (!reader.hasField(field)) {
      reader.replace(field, { present: true, value: {} })
    }
    reader.write(field, paneKey, { present: false, value: undefined })
  }
  const repo = getRepoIdFromWorktreeId(surface.worktreeId)
  reader.write('terminalTopologyRevisionByRepoId', repo, {
    present: true,
    value: (reader.unit('terminalTopologyRevisionByRepoId', repo).value ?? 0) + 1
  })
}

export function retireTerminalSurfaceFromPersistence(
  session: WorkspaceSessionState,
  surface: RetiredTerminalSurface
): WorkspaceSessionState {
  const reader = new SessionUnitReader(session, new SessionUnitIndex(session))
  reader.admitFields(true)
  reduceTerminalSurfaceRetirement(reader, surface)
  return reader.snapshot()
}

/** The requested owner/tab/pane identities remain available even when no row exists. */
export function reduceTerminalSurfaceRetirement(
  reader: SessionUnitReader,
  surface: RetiredTerminalSurface
): void {
  const owner = surface.worktreeId,
    tabId = surface.parentTabId,
    paneKey = `${tabId}:${surface.leafId}`
  const boundIncarnation = reader.unit('terminalPtyIncarnationsByPaneKey', paneKey).value
  if (surface.incarnationId && boundIncarnation && boundIncarnation !== surface.incarnationId) {
    return
  }
  const rows = reader.unit('tabsByWorktree', owner).value ?? []
  const tab = rows.find((row) => row.id === tabId)
  const layout = reader.unit('terminalLayoutsByTabId', tabId).value
  const exactLeaf = Boolean(layout && layoutContainsLeaf(layout.root, surface.leafId))
  const leafPty = exactLeaf ? layout?.ptyIdsByLeafId?.[surface.leafId] : undefined
  if (leafPty && leafPty !== surface.ptyId) {
    return
  }
  if (!exactLeaf && !(!layout && tab?.ptyId === surface.ptyId)) {
    recordTerminalSurfaceRetirement(reader, surface, paneKey)
    return
  }
  const nextLayout =
    exactLeaf && layout ? retireLeavesFromTerminalLayout(layout, new Set([surface.leafId])) : null
  const removeParent = !nextLayout
  const nextRows = removeParent
    ? rows.filter((row) => row.id !== tabId)
    : rows.map((row) =>
        row.id === tabId
          ? {
              ...row,
              ptyId:
                nextLayout.ptyIdsByLeafId?.[nextLayout.activeLeafId ?? ''] ??
                Object.values(nextLayout.ptyIdsByLeafId ?? {})[0] ??
                null
            }
          : row
      )
  reader.write('tabsByWorktree', owner, { present: true, value: nextRows })
  reader.write(
    'terminalLayoutsByTabId',
    tabId,
    nextLayout ? { present: true, value: nextLayout } : { present: false, value: undefined }
  )
  const unified = reader.unit('unifiedTabs', owner).value ?? []
  const nextUnified = removeParent
    ? unified.filter((tab) => tab.id !== tabId && tab.entityId !== tabId)
    : unified
  if (reader.hasField('unifiedTabs')) {
    reader.write('unifiedTabs', owner, { present: true, value: nextUnified })
  }
  const validIds = new Set([...nextUnified.map((tab) => tab.id), ...nextRows.map((tab) => tab.id)])
  const groups = repairMobileSessionTabGroupsAfterRetirement(
    reader.unit('tabGroups', owner).value,
    validIds
  )
  if (reader.hasField('tabGroups')) {
    reader.write('tabGroups', owner, {
      present: true,
      value: (groups ?? []).map((group) => ({ ...group, worktreeId: owner }))
    })
  }
  const groupLayout = pruneTabGroupLayoutAfterRetirement(
    reader.unit('tabGroupLayouts', owner).value,
    new Set(groups?.map((group) => group.id) ?? [])
  )
  if (reader.hasField('tabGroupLayouts')) {
    reader.write(
      'tabGroupLayouts',
      owner,
      groupLayout ? { present: true, value: groupLayout } : { present: false, value: undefined }
    )
  }
  const priorActive = reader.unit('activeTabIdByWorktree', owner).value
  const active =
    (priorActive && validIds.has(priorActive) ? priorActive : undefined) ??
    groups?.find((group) => group.id === reader.unit('activeGroupIdByWorktree', owner).value)
      ?.activeTabId ??
    groups?.[0]?.activeTabId ??
    [...validIds][0] ??
    null
  reader.write('activeTabIdByWorktree', owner, { present: true, value: active })
  const type = visibleTypeForContentType(nextUnified.find((tab) => tab.id === active)?.contentType)
  if (reader.hasField('activeTabTypeByWorktree')) {
    if (type) {
      reader.write('activeTabTypeByWorktree', owner, { present: true, value: type })
    } else if (!active) {
      reader.write('activeTabTypeByWorktree', owner, { present: false, value: undefined })
    }
  }
  const activeGroup =
    groups?.find((group) => group.tabOrder.includes(active ?? ''))?.id ?? groups?.[0]?.id
  if (reader.hasField('activeGroupIdByWorktree')) {
    reader.write(
      'activeGroupIdByWorktree',
      owner,
      activeGroup ? { present: true, value: activeGroup } : { present: false, value: undefined }
    )
  }
  const remote = reader.unit('remoteSessionIdsByTabId', tabId).value
  if (reader.hasField('remoteSessionIdsByTabId')) {
    if (removeParent) {
      reader.write('remoteSessionIdsByTabId', tabId, { present: false, value: undefined })
    } else if (remote === surface.ptyId) {
      const remaining =
        nextLayout?.ptyIdsByLeafId?.[nextLayout.activeLeafId ?? ''] ??
        Object.values(nextLayout?.ptyIdsByLeafId ?? {})[0]
      reader.write(
        'remoteSessionIdsByTabId',
        tabId,
        remaining ? { present: true, value: remaining } : { present: false, value: undefined }
      )
    }
  }
  if (reader.field('activeTabId').value === tabId) {
    reader.replace('activeTabId', { present: true, value: active })
  }
  recordTerminalSurfaceRetirement(reader, surface, paneKey)
}

export function sanitizeWorkspaceSessionTerminalRetirements(
  incoming: WorkspaceSessionState,
  prior: WorkspaceSessionState | undefined
): WorkspaceSessionState {
  const base = prior ?? getDefaultWorkspaceSession()
  const reader = SessionUnitReader.between(base, incoming, new SessionUnitIndex(base))
  reader.admitFields(true)
  reduceSessionTerminalRetirements(reader, selectSessionUnits(reader, [], true))
  return reader.snapshot()
}

export function reduceSessionTerminalRetirements(
  reader: SessionUnitReader,
  selection: SessionUnitSelection,
  fencedRevisions?: ReadonlyMap<string, number>
): void {
  if (
    !reader.policy('terminalSurfaceTombstonesByPaneKey', 'prior') &&
    !reader.policy('terminalSurfaceTombstonesByPaneKey') &&
    !reader.policy('terminalTopologyRevisionByRepoId', 'prior')
  ) {
    return
  }
  const panes = new Set([
    ...reader.index.keys('terminalSurfaceTombstonesByPaneKey'),
    ...reader.keys('terminalSurfaceTombstonesByPaneKey')
  ])
  for (const pane of panes) {
    const prior = reader.unit('terminalSurfaceTombstonesByPaneKey', pane, 'prior').value
    const incoming = reader.unit('terminalSurfaceTombstonesByPaneKey', pane).value
    const tombstone = incoming ?? prior
    if (!tombstone) {
      continue
    }
    const binding = reader.unit('terminalPtyIncarnationsByPaneKey', pane)
    if (!binding.present) {
      reader.write(
        'terminalPtyIncarnationsByPaneKey',
        pane,
        reader.unit('terminalPtyIncarnationsByPaneKey', pane, 'prior')
      )
    }
    reduceTerminalSurfaceRetirement(reader, tombstone)
    reader.write('terminalSurfaceTombstonesByPaneKey', pane, { present: false, value: undefined })
  }
  // Retirement consumes the complete policy field, even when its selected domain is empty.
  reader.replace('terminalSurfaceTombstonesByPaneKey', { present: true, value: {} })
  const rebased = reduceSessionTerminalMembership(
    reader,
    selection.get('tabsByWorktree') ?? [],
    selection.get('terminalTopologyRevisionByRepoId') ?? [],
    fencedRevisions
  )
  if (rebased) {
    reduceSessionIncarnationMembership(
      reader,
      selection.get('terminalPtyIncarnationsByPaneKey') ?? []
    )
  }
}
