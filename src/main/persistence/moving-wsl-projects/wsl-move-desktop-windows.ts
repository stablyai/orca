import type { Store } from '../../persistence'
import type { PersistedDesktopWindowState } from '../../../shared/desktop-window-state-types'
import type { DesktopLayoutView } from '../../../shared/workspace-layout/workspace-layout-beside'
import { emptyLayoutViewRecord } from '../../../shared/workspace-layout/workspace-layout-views'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import {
  composeWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  buildWorktreeIdByFileId,
  buildWorktreeIdByTabId
} from '../../../shared/workspace-session-host-records'
import { ownedEditorFileId } from '../../../shared/workspace-session-pane-ownership'
import { rewriteOrcadMigrationWorktreeId } from '../../ssh/orcad-migration-path-rewrite'
import { parseEditorFileId } from './wsl-move-canonical-form'
import {
  registerWslMoveDesktopRewriteStore,
  type WslMoveDesktopRewriteContext
} from './wsl-move-desktop-rewrite-stores'

type WindowRewriteStore = Pick<
  Store,
  'getUI' | 'updateUI' | 'getWorkspaceSession' | 'flushPendingOrThrowAsync'
>

export function registerWslMoveDesktopWindowRewrite(store: WindowRewriteStore): void {
  registerWslMoveDesktopRewriteStore({
    id: 'desktopWindows',
    side: 'main',
    run: (context) => {
      const windows = structuredClone(store.getUI().desktopWindows ?? {})
      const session = store.getWorkspaceSession('local')
      const byTab = buildWorktreeIdByTabId(session)
      const byFile = buildWorktreeIdByFileId(session)
      for (const window of Object.values(windows)) {
        rewriteWindow(window, context, byTab, byFile)
      }
      store.updateUI({ desktopWindows: windows })
    },
    flush: () => store.flushPendingOrThrowAsync()
  })
}

function moveEntries<T>(
  source: Record<string, T> | undefined,
  destination: Record<string, T> | undefined,
  inScope: (key: string) => boolean,
  rewriteKey: (key: string) => string,
  rewriteValue: (value: T) => T = (value) => value
): [Record<string, T>, Record<string, T>] {
  const remaining = { ...source }
  const moved = { ...destination }
  for (const [key, value] of Object.entries(source ?? {})) {
    if (!inScope(key)) {
      continue
    }
    const nextKey = rewriteKey(key)
    if (Object.hasOwn(moved, nextKey)) {
      throw new Error('wsl_move_desktop_window_view_collision')
    }
    moved[nextKey] = rewriteValue(value)
    delete remaining[key]
  }
  return [remaining, moved]
}

function rewriteWindow(
  window: PersistedDesktopWindowState,
  context: WslMoveDesktopRewriteContext,
  byTab: Map<string, string>,
  byFile: Map<string, string>
): void {
  const { cutover, destinationHostId, rewritePath } = context
  const repos = new Set(cutover.manifest.source.scopeRepoIds)
  const folders = new Set(cutover.manifest.source.scopeFolderWorkspaceIds)
  const bare = (key: string): string =>
    isWorktreeHostIdentity(key) ? getWorktreeIdFromHostIdentity(key) : key
  const inScope = (key: string): boolean => {
    if (
      isWorktreeHostIdentity(key) &&
      getExecutionHostIdFromWorktreeHostIdentity(key) !== 'local'
    ) {
      return false
    }
    const value = bare(key)
    const parsed = parseWorkspaceKey(value)
    return parsed?.type === 'folder'
      ? folders.has(parsed.folderWorkspaceId)
      : repos.has(getRepoIdFromWorktreeId(parsed?.worktreeId ?? value))
  }
  const rewriteOwner = (key: string): string => {
    const value = bare(key)
    const parsed = parseWorkspaceKey(value)
    const rewritten =
      parsed?.type === 'folder'
        ? value
        : parsed?.type === 'worktree'
          ? worktreeWorkspaceKey(rewriteOrcadMigrationWorktreeId(parsed.worktreeId, rewritePath))
          : rewriteOrcadMigrationWorktreeId(value, rewritePath)
    return isWorktreeHostIdentity(key)
      ? composeWorktreeHostIdentity(destinationHostId, rewritten)
      : rewritten
  }
  const rewriteFile = (id: string): string => {
    const parsed = parseEditorFileId(id)
    return parsed
      ? ownedEditorFileId(
          rewritePath.path(parsed[2], 'absolute'),
          rewriteOwner(parsed[0]),
          parsed[1] === 'local' ? cutover.destinationEnvironmentId : parsed[1]
        )
      : rewritePath.path(id, 'maybe-absolute')
  }
  const selected = window.ui?.lastActiveWorktreeId
  if (selected && inScope(selected)) {
    window.ui = {
      ...window.ui,
      lastActiveWorktreeId: composeWorktreeHostIdentity(
        destinationHostId,
        bare(rewriteOwner(selected))
      )
    }
  }
  const source = window.viewsByHostId?.local
  if (!source) {
    return
  }
  const fileInScope = (id: string): boolean => {
    const parsed = parseEditorFileId(id)
    const owner = parsed?.[0] || byFile.get(parsed?.[2] ?? id)
    return owner !== undefined && inScope(owner)
  }
  const tabInScope = (id: string): boolean => {
    const owner = byTab.get(id)
    return owner !== undefined && inScope(owner)
  }
  const active = source.activeWorkspaceKey ?? source.activeWorktreeId
  const hasWorkspace = [
    source.groups,
    source.lastFocusedAt,
    source.editorDrafts,
    source.activeFileIdByWorktree,
    source.activeBrowserTabIdByWorktree,
    source.activeTabTypeByWorktree,
    source.activeTabIdByWorktree,
    source.activeGroupIdByWorktree,
    source.lastVisitedAtByWorktreeId
  ].some((record) => Object.keys(record ?? {}).some(inScope))
  if (
    !hasWorkspace &&
    !(active && inScope(active)) &&
    !Object.keys(source.panes).some(tabInScope) &&
    !Object.keys(source.markdownFrontmatterVisible ?? {}).some(fileInScope)
  ) {
    return
  }
  const local = structuredClone(source)
  const destination = structuredClone(
    window.viewsByHostId?.[destinationHostId] ?? emptyLayoutViewRecord()
  )
  const identity = (key: string): string => key
  const rewriteGroup = (
    group: DesktopLayoutView['groups'][string]
  ): DesktopLayoutView['groups'][string] =>
    Object.fromEntries(
      Object.entries(group).map(([id, selection]) => [
        id,
        {
          ...selection,
          activeTabId: selection.activeTabId === null ? null : rewriteFile(selection.activeTabId),
          ...(selection.recentTabIds
            ? { recentTabIds: selection.recentTabIds.map(rewriteFile) }
            : {})
        }
      ])
    )
  ;[local.groups, destination.groups] = moveEntries(
    local.groups,
    destination.groups,
    inScope,
    rewriteOwner,
    rewriteGroup
  )
  ;[local.lastFocusedAt, destination.lastFocusedAt] = moveEntries(
    local.lastFocusedAt,
    destination.lastFocusedAt,
    inScope,
    rewriteOwner,
    (entries) =>
      Object.fromEntries(Object.entries(entries).map(([id, time]) => [rewriteFile(id), time]))
  )
  ;[local.editorDrafts, destination.editorDrafts] = moveEntries(
    local.editorDrafts,
    destination.editorDrafts,
    inScope,
    rewriteOwner,
    (entries) =>
      Object.fromEntries(Object.entries(entries).map(([id, draft]) => [rewriteFile(id), draft]))
  )
  ;[local.panes, destination.panes] = moveEntries(
    local.panes,
    destination.panes,
    tabInScope,
    identity
  )
  ;[local.activeFileIdByWorktree, destination.activeFileIdByWorktree] = moveEntries(
    local.activeFileIdByWorktree,
    destination.activeFileIdByWorktree,
    inScope,
    rewriteOwner,
    (id) => (id === null ? null : rewriteFile(id))
  )
  ;[local.markdownFrontmatterVisible, destination.markdownFrontmatterVisible] = moveEntries(
    local.markdownFrontmatterVisible,
    destination.markdownFrontmatterVisible,
    fileInScope,
    rewriteFile
  )
  ;[local.activeBrowserTabIdByWorktree, destination.activeBrowserTabIdByWorktree] = moveEntries(
    local.activeBrowserTabIdByWorktree,
    destination.activeBrowserTabIdByWorktree,
    inScope,
    rewriteOwner
  )
  ;[local.activeTabTypeByWorktree, destination.activeTabTypeByWorktree] = moveEntries(
    local.activeTabTypeByWorktree,
    destination.activeTabTypeByWorktree,
    inScope,
    rewriteOwner
  )
  ;[local.activeTabIdByWorktree, destination.activeTabIdByWorktree] = moveEntries(
    local.activeTabIdByWorktree,
    destination.activeTabIdByWorktree,
    inScope,
    rewriteOwner
  )
  ;[local.activeGroupIdByWorktree, destination.activeGroupIdByWorktree] = moveEntries(
    local.activeGroupIdByWorktree,
    destination.activeGroupIdByWorktree,
    inScope,
    rewriteOwner
  )
  ;[local.lastVisitedAtByWorktreeId, destination.lastVisitedAtByWorktreeId] = moveEntries(
    local.lastVisitedAtByWorktreeId,
    destination.lastVisitedAtByWorktreeId,
    inScope,
    rewriteOwner
  )
  if (
    active &&
    inScope(active) &&
    (!local.activeWorkspaceExecutionHostId || local.activeWorkspaceExecutionHostId === 'local')
  ) {
    destination.activeRepoId = local.activeRepoId
    destination.activeWorktreeId = local.activeWorktreeId
      ? rewriteOwner(local.activeWorktreeId)
      : null
    const scope = local.activeWorkspaceKey ? parseWorkspaceKey(local.activeWorkspaceKey) : null
    destination.activeWorkspaceKey =
      scope?.type === 'worktree'
        ? worktreeWorkspaceKey(rewriteOrcadMigrationWorktreeId(scope.worktreeId, rewritePath))
        : local.activeWorkspaceKey
    destination.activeWorkspaceExecutionHostId = destinationHostId
    destination.activeTabId = local.activeTabId
    local.activeRepoId = null
    local.activeWorktreeId = null
    local.activeWorkspaceKey = null
    local.activeWorkspaceExecutionHostId = null
    local.activeTabId = null
  }
  window.viewsByHostId = { ...window.viewsByHostId, local, [destinationHostId]: destination }
}
