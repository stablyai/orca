// Boot stored partitions through real startup hydration, then compare user-visible state.

import { vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from '@/lib/workspace-session-host-hydration'
import { collectFolderWorkspaceKeysFromSession } from '@/lib/workspace-session-hydration-keys'
import type { AppState } from '../store/types'
import type { createTestStore } from '../store/slices/store-test-helpers'
import { reconcileHydratedWorkspaceTabModels } from './reconcile-hydrated-workspace-tab-models'

/** One stored session partition and the host it is stored under. */
export type StoredPartition = { hostId: ExecutionHostId; session: WorkspaceSessionState }

/** First-paint local repos for referenced Git workspaces, without listings. Remote-server catalogs are skipped at startup. */
function firstPaintRepos(partitions: readonly StoredPartition[]): AppState['repos'] {
  const repos = new Map<string, AppState['repos'][number]>()
  for (const { hostId, session } of partitions) {
    const host = parseExecutionHostId(hostId)
    if (host?.kind === 'runtime') {
      continue
    }
    for (const key of Object.keys(session.tabsByWorktree)) {
      const id = getRepoIdFromWorktreeId(key)
      if (!key.startsWith(`${id}::`) || repos.has(id)) {
        continue
      }
      repos.set(id, {
        id,
        path: key.slice(id.length + 2),
        displayName: id,
        badgeColor: '#000',
        addedAt: 0,
        connectionId: host?.kind === 'ssh' ? host.targetId : null,
        executionHostId: hostId
      })
    }
  }
  return [...repos.values()]
}

/** Match use-app-startup-hydration’s call order on a fresh test store. */
export async function bootWindowFromPartitions(
  store: ReturnType<typeof createTestStore>,
  partitions: readonly StoredPartition[]
): Promise<AppState> {
  let minted = 0
  // Group and tab ids the window mints must match across the two boots being compared.
  const randomUUID = vi
    .spyOn(globalThis.crypto, 'randomUUID')
    .mockImplementation(() => `00000000-0000-4000-8000-${String(++minted).padStart(12, '0')}`)
  try {
    store.setState({ repos: firstPaintRepos(partitions) })
    const read = async (hostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID) =>
      structuredClone(
        partitions.find((partition) => partition.hostId === hostId)?.session ??
          getDefaultWorkspaceSession()
      )
    const hostIdsOfKind = (kind: 'ssh' | 'runtime') =>
      partitions
        .map((partition) => partition.hostId)
        .filter((hostId) => parseExecutionHostId(hostId)?.kind === kind)
    const sessionRead = await fetchWorkspaceSessionWithRuntimeHostOwners(
      { get: read, listHostIds: async () => hostIdsOfKind('ssh') },
      store.getState().repos,
      hostIdsOfKind('runtime')
    )
    const actions = store.getState()
    const options = {
      additionalValidWorkspaceKeys: collectFolderWorkspaceKeysFromSession(sessionRead.session)
    }
    actions.hydrateWorkspaceSession(sessionRead.session, {
      ...options,
      runtimeHostIdByWorkspaceSessionKey: sessionRead.runtimeHostIdByWorkspaceSessionKey,
      contestedHostWorkspaceSessions: sessionRead.contestedHostWorkspaceSessions,
      contestedPrimaryHostBySessionKey: sessionRead.contestedPrimaryHostBySessionKey
    })
    actions.hydrateTabsSession(sessionRead.session, options)
    actions.hydrateEditorSession(sessionRead.session, options)
    actions.hydrateBrowserSession(sessionRead.session, options)
    reconcileHydratedWorkspaceTabModels(
      sessionRead.session,
      store.getState().reconcileWorktreeTabModels
    )
    return store.getState()
  } finally {
    randomUUID.mockRestore()
  }
}

type PaneView = { pane: string | null } | { split: string; first: PaneView; second: PaneView }

/** Panes by position, each naming the terminal it binds; leaf ids are not shown. */
function paneView(node: TerminalPaneLayoutNode, layout: TerminalLayoutSnapshot): PaneView {
  if (node.type === 'leaf') {
    return { pane: layout.ptyIdsByLeafId?.[node.leafId] ?? null }
  }
  return {
    split: node.direction,
    first: paneView(node.first, layout),
    second: paneView(node.second, layout)
  }
}

function leafPosition(
  node: TerminalPaneLayoutNode,
  leafId: string | null,
  path = ''
): string | null {
  if (node.type === 'leaf') {
    return node.leafId === leafId ? path || 'root' : null
  }
  return (
    leafPosition(node.first, leafId, `${path}1`) ?? leafPosition(node.second, leafId, `${path}2`)
  )
}

type GroupLayoutView = number | { split: string; first: GroupLayoutView; second: GroupLayoutView }

function groupLayoutView(node: TabGroupLayoutNode, groupIds: string[]): GroupLayoutView {
  if (node.type === 'leaf') {
    return groupIds.indexOf(node.groupId)
  }
  return {
    split: node.direction,
    first: groupLayoutView(node.first, groupIds),
    second: groupLayoutView(node.second, groupIds)
  }
}

/** Project visible path/value pairs. Name groups by position (IDs are invisible); retain tab IDs because they must survive restarts. */
export function projectStartupWindowView(state: AppState): Record<string, unknown> {
  const view: Record<string, unknown> = {
    'active.workspace': state.activeWorktreeId,
    'active.terminal': state.activeTabId
  }
  const workspaceKeys = new Set([
    ...Object.keys(state.tabsByWorktree),
    ...Object.keys(state.unifiedTabsByWorktree),
    ...state.openFiles.map((file) => file.worktreeId),
    ...Object.keys(state.browserTabsByWorktree)
  ])
  for (const key of [...workspaceKeys].sort()) {
    const groups = state.groupsByWorktree[key] ?? []
    const groupIds = groups.map((group) => group.id)
    const layout = state.layoutByWorktree[key]
    view[`${key} groups`] = layout ? groupLayoutView(layout, groupIds) : groupIds.length
    groups.forEach((group, index) => {
      view[`${key} group ${index} tabs`] = group.tabOrder
      view[`${key} group ${index} active tab`] = group.activeTabId
    })
    view[`${key} active group`] = groupIds.indexOf(state.activeGroupIdByWorktree[key] ?? '')
    view[`${key} active terminal`] = state.activeTabIdByWorktree[key] ?? null
    view[`${key} active file`] = state.activeFileIdByWorktree[key] ?? null
    view[`${key} active kind`] = state.activeTabTypeByWorktree[key] ?? null
    for (const tab of state.unifiedTabsByWorktree[key] ?? []) {
      view[`${key} tab ${tab.id}`] = {
        kind: tab.contentType,
        shows: tab.entityId,
        group: groupIds.indexOf(tab.groupId),
        label: tab.customLabel ?? tab.label
      }
    }
    for (const row of state.tabsByWorktree[key] ?? []) {
      const panes = state.terminalLayoutsByTabId[row.id]
      const terminal = `${key} terminal ${row.id}`
      // Phones and the CLI show the row title; the desktop tab shows its tab-bar label.
      view[`${terminal} phone and CLI title`] = row.customTitle ?? row.title
      view[`${terminal} panes`] = panes?.root ? paneView(panes.root, panes) : null
      view[`${terminal} focused pane`] = panes?.root
        ? leafPosition(panes.root, panes.activeLeafId)
        : null
      view[`${terminal} reattaches`] = state.pendingReconnectPtyIdByTabId[row.id] ?? null
    }
    view[`${key} open files`] = state.openFiles
      .filter((file) => file.worktreeId === key)
      .map((file) => file.filePath)
    view[`${key} browser tabs`] = (state.browserTabsByWorktree[key] ?? []).map((tab) => tab.url)
  }
  return view
}

/** Each path whose value differs between two views, with both values. */
export function diffStartupWindowViews(
  stored: Record<string, unknown>,
  normalized: Record<string, unknown>
): { path: string; stored: unknown; normalized: unknown }[] {
  const paths = [...new Set([...Object.keys(stored), ...Object.keys(normalized)])].sort()
  return paths
    .filter((path) => JSON.stringify(stored[path]) !== JSON.stringify(normalized[path]))
    .map((path) => ({ path, stored: stored[path], normalized: normalized[path] }))
}
