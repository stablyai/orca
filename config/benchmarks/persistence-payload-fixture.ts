import type { Repo, Tab, TabGroup, TabGroupLayoutNode, Worktree } from '../../src/shared/types'
import type { OpenFile } from '../../src/renderer/src/store/slices/editor'
import type { WorkspaceSessionSnapshot } from '../../src/renderer/src/lib/workspace-session'

export type SyntheticPersistenceProfile = {
  repoCount: number
  worktreesPerRepo: number
  editorFilesPerWorktree: number
  dirtyEvery: number
  draftBytes: number
}

function makeTextBytes(length: number): string {
  return 'x'.repeat(length)
}

function makeRepo(index: number): Repo {
  return {
    id: `repo-${index}`,
    path: `/tmp/orca-persistence/repo-${index}`,
    displayName: `Repo ${index}`,
    badgeColor: 'blue',
    addedAt: 1_700_000_000_000 + index
  } as Repo
}

function makeWorktree(repo: Repo, index: number): Worktree {
  const path = `${repo.path}/wt-${index}`
  return {
    id: `${repo.id}::${path}`,
    instanceId: `${repo.id}-instance-${index}`,
    repoId: repo.id,
    path,
    head: `head-${index}`,
    branch: index === 0 ? 'main' : `feature/${index}`,
    isBare: false,
    isMainWorktree: index === 0,
    isSparse: false,
    displayName: index === 0 ? 'main' : `feature-${index}`,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: index,
    manualOrder: index,
    lastActivityAt: 1_700_000_000_000 + index,
    pendingFirstAgentMessageRename: false,
    firstAgentMessageRenameError: null,
    baseRef: 'main'
  } as Worktree
}

function makeOpenFile(worktree: Worktree, fileIndex: number, isDirty: boolean): OpenFile {
  const relativePath = `src/feature-${fileIndex}.md`
  const filePath = `${worktree.path}/${relativePath}`
  return {
    id: filePath,
    filePath,
    relativePath,
    worktreeId: worktree.id,
    language: 'markdown',
    isDirty,
    mode: 'edit'
  } as OpenFile
}

function makeUnifiedTab(file: OpenFile, groupId: string, sortOrder: number): Tab {
  return {
    id: file.id,
    entityId: file.id,
    groupId,
    worktreeId: file.worktreeId,
    contentType: 'editor',
    label: file.relativePath,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 1_700_000_000_000 + sortOrder,
    isPreview: false,
    isPinned: false
  }
}

function addWorktreeEditorState(args: {
  snapshot: {
    openFiles: OpenFile[]
    editorDrafts: Record<string, string>
    markdownFrontmatterVisible: Record<string, boolean>
    activeFileIdByWorktree: Record<string, string | null>
    activeTabTypeByWorktree: Record<string, 'editor'>
    unifiedTabsByWorktree: Record<string, Tab[]>
    groupsByWorktree: Record<string, TabGroup[]>
    layoutByWorktree: Record<string, TabGroupLayoutNode>
    activeGroupIdByWorktree: Record<string, string>
    lastVisitedAtByWorktreeId: Record<string, number>
  }
  worktree: Worktree
  profile: SyntheticPersistenceProfile
  fileOrdinal: number
}): number {
  const { snapshot, worktree, profile } = args
  const groupId = `group-${worktree.id}`
  const tabs: Tab[] = []
  let fileOrdinal = args.fileOrdinal
  for (let fileIndex = 0; fileIndex < profile.editorFilesPerWorktree; fileIndex += 1) {
    const isDirty = fileOrdinal % profile.dirtyEvery === 0
    const file = makeOpenFile(worktree, fileIndex, isDirty)
    snapshot.openFiles.push(file)
    tabs.push(makeUnifiedTab(file, groupId, fileOrdinal))
    if (isDirty) {
      snapshot.editorDrafts[file.id] = makeTextBytes(profile.draftBytes)
    }
    if (fileOrdinal % 17 === 0) {
      snapshot.markdownFrontmatterVisible[file.id] = true
    }
    fileOrdinal += 1
  }
  snapshot.activeFileIdByWorktree[worktree.id] = tabs[0]?.id ?? null
  snapshot.activeTabTypeByWorktree[worktree.id] = 'editor'
  snapshot.unifiedTabsByWorktree[worktree.id] = tabs
  snapshot.groupsByWorktree[worktree.id] = [
    {
      id: groupId,
      worktreeId: worktree.id,
      activeTabId: tabs[0]?.id ?? null,
      tabOrder: tabs.map((tab) => tab.id),
      recentTabIds: tabs.map((tab) => tab.id)
    }
  ]
  snapshot.layoutByWorktree[worktree.id] = { type: 'leaf', groupId }
  snapshot.activeGroupIdByWorktree[worktree.id] = groupId
  snapshot.lastVisitedAtByWorktreeId[worktree.id] = 1_700_000_000_000 + fileOrdinal
  return fileOrdinal
}

export function makeSyntheticWorkspaceSessionSnapshot(
  profile: SyntheticPersistenceProfile
): WorkspaceSessionSnapshot {
  const repos = Array.from({ length: profile.repoCount }, (_, index) => makeRepo(index))
  const partial = {
    worktreesByRepo: {} as Record<string, Worktree[]>,
    openFiles: [] as OpenFile[],
    editorDrafts: {} as Record<string, string>,
    markdownFrontmatterVisible: {} as Record<string, boolean>,
    activeFileIdByWorktree: {} as Record<string, string | null>,
    activeTabTypeByWorktree: {} as Record<string, 'editor'>,
    unifiedTabsByWorktree: {} as Record<string, Tab[]>,
    groupsByWorktree: {} as Record<string, TabGroup[]>,
    layoutByWorktree: {} as Record<string, TabGroupLayoutNode>,
    activeGroupIdByWorktree: {} as Record<string, string>,
    lastVisitedAtByWorktreeId: {} as Record<string, number>
  }

  let fileOrdinal = 0
  for (const repo of repos) {
    partial.worktreesByRepo[repo.id] = []
    for (let worktreeIndex = 0; worktreeIndex < profile.worktreesPerRepo; worktreeIndex += 1) {
      const worktree = makeWorktree(repo, worktreeIndex)
      partial.worktreesByRepo[repo.id].push(worktree)
      fileOrdinal = addWorktreeEditorState({
        snapshot: partial,
        worktree,
        profile,
        fileOrdinal
      })
    }
  }

  return {
    activeRepoId: repos[0]?.id ?? null,
    activeWorkspaceKey: null,
    activeWorktreeId: partial.worktreesByRepo[repos[0]?.id ?? '']?.[0]?.id ?? null,
    activeTabId: null,
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    activeTabIdByWorktree: {},
    openFiles: partial.openFiles,
    editorDrafts: partial.editorDrafts,
    markdownFrontmatterVisible: partial.markdownFrontmatterVisible,
    activeFileIdByWorktree: partial.activeFileIdByWorktree,
    activeTabTypeByWorktree: partial.activeTabTypeByWorktree,
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: {},
    browserUrlHistory: [],
    unifiedTabsByWorktree: partial.unifiedTabsByWorktree,
    groupsByWorktree: partial.groupsByWorktree,
    layoutByWorktree: partial.layoutByWorktree,
    activeGroupIdByWorktree: partial.activeGroupIdByWorktree,
    sshConnectionStates: new Map(),
    repos,
    worktreesByRepo: partial.worktreesByRepo,
    lastKnownRelayPtyIdByTabId: {},
    lastVisitedAtByWorktreeId: partial.lastVisitedAtByWorktreeId,
    defaultTerminalTabsAppliedByWorktreeId: {},
    sleepingAgentSessionsByPaneKey: {}
  } as WorkspaceSessionSnapshot
}

export function dirtyDraftBytes(snapshot: WorkspaceSessionSnapshot): number {
  return Object.values(snapshot.editorDrafts).reduce((total, draft) => total + draft.length, 0)
}
