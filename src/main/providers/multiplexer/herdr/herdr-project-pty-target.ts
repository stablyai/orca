import type { Project } from '../../../../shared/project-types'
import type {
  TerminalPaneLayoutNode,
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../shared/terminal-tab-types'
import { basename } from 'node:path'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { Store } from '../../../persistence'
import {
  commitHerdrHostActivation,
  projectWantsHerdr,
  resolveSpawnHostId
} from './herdr-project-backend'
import type { HerdrPtyTargetResolver } from './herdr-pty-provider'
import type { HerdrPtyIdentity, HerdrPtyTarget } from './herdr-pty-types'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import type { PtySpawnOptions } from '../../pty-provider-contract'
import type { HerdrWorktreeDescriptor } from './ensure-herdr-workspace'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

function repoPathForWorktree(
  store: Pick<Store, 'getRepo'>,
  worktreeId: string
): string | undefined {
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  if (!parsed) {
    return undefined
  }
  const repo = store.getRepo(parsed.repoId)
  if (!repo?.path || !isGitRepoKind(repo)) {
    return undefined
  }
  return repo.path
}

function collectProjectWorktrees(
  store: Pick<Store, 'getRepo' | 'getAllWorktreeMeta'>,
  project: Project,
  current: HerdrWorktreeDescriptor
): HerdrWorktreeDescriptor[] {
  const byId = new Map<string, HerdrWorktreeDescriptor>()
  const add = (worktree: HerdrWorktreeDescriptor): void => {
    if (!byId.has(worktree.id)) {
      byId.set(worktree.id, worktree)
    }
  }
  add(current)
  for (const repoId of project.sourceRepoIds ?? []) {
    const repo = store.getRepo(repoId)
    if (!repo?.path) {
      continue
    }
    const repoPath = isGitRepoKind(repo) ? repo.path : undefined
    add({
      id: `${repo.id}::${repo.path}`,
      path: repo.path,
      displayName: repo.displayName || basename(repo.path),
      ...(repoPath ? { repoPath } : {})
    })
    for (const [worktreeId, meta] of Object.entries(store.getAllWorktreeMeta())) {
      const parsed = splitWorktreeIdForFilesystem(worktreeId)
      if (!parsed || parsed.repoId !== repo.id) {
        continue
      }
      add({
        id: worktreeId,
        path: parsed.worktreePath,
        displayName: meta.displayName || basename(parsed.worktreePath),
        ...(repoPath ? { repoPath } : {})
      })
    }
  }
  return [...byId.values()]
}

function extractLeafIdFromPaneKey(paneKey: string): string | null {
  const colonIndex = paneKey.lastIndexOf(':')
  if (colonIndex === -1) {
    return null
  }
  return paneKey.slice(colonIndex + 1)
}

function countLeaves(node: TerminalPaneLayoutNode | null): number {
  if (!node) {
    return 0
  }
  if (node.type === 'leaf') {
    return 1
  }
  return countLeaves(node.first) + countLeaves(node.second)
}

function resolveLayout(
  leafId: string,
  rendererLayout: TerminalLayoutSnapshot | undefined,
  persistedLayout: TerminalLayoutSnapshot | undefined
): TerminalLayoutSnapshot {
  const rendererLeaves = rendererLayout ? countLeaves(rendererLayout.root) : 0
  const persistedLeaves = persistedLayout ? countLeaves(persistedLayout.root) : 0

  if (rendererLeaves > 0 || persistedLeaves > 0) {
    return rendererLeaves >= persistedLeaves ? rendererLayout! : persistedLayout!
  }

  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null
  }
}

function resolveProject(
  store: Store,
  worktreeId: string | null,
  persistedIdentity: HerdrPtyIdentity | null
): Project {
  if (persistedIdentity?.projectId) {
    const project = store.getProjects().find((p) => p.id === persistedIdentity.projectId)
    if (project) {
      return project
    }
    // Why: attach fences compare the encoded pty id against the persisted
    // owner; deriving a new project id here would change every binding token
    // and the encoded id, failing terminal_pane_owner_changed on reattach.
    return {
      id: persistedIdentity.projectId,
      displayName: persistedIdentity.projectId,
      badgeColor: '#000000',
      sourceRepoIds: [],
      createdAt: 0,
      updatedAt: 0
    }
  }

  const meta = store.getWorktreeMeta(worktreeId ?? '')
  if (meta?.projectId) {
    const project = store.getProjects().find((p) => p.id === meta.projectId)
    if (project) {
      return project
    }
  }

  if (worktreeId) {
    const repoId = splitWorktreeIdForFilesystem(worktreeId)?.repoId
    if (repoId) {
      const project = store.getProjects().find((p) => p.sourceRepoIds?.includes(repoId))
      if (project) {
        return project
      }
    }
  }

  // Why: a missing record must not degrade to an undefined projectId — every
  // unmatched worktree would hash into the same herdr session and bindings.
  // Derive a stable, namespaced id from the repo portion instead.
  const repoId = worktreeId ? splitWorktreeIdForFilesystem(worktreeId)?.repoId : null
  const id = `project:${repoId ?? 'unknown'}`
  return {
    id,
    displayName: repoId ?? 'Project',
    badgeColor: '#000000',
    sourceRepoIds: repoId ? [repoId] : [],
    createdAt: 0,
    updatedAt: 0
  }
}

const FLOATING_PROJECT: Project = {
  id: 'orca-global',
  displayName: 'Orca Global',
  badgeColor: '#000000',
  sourceRepoIds: [],
  herdrSessionName: 'orca-global',
  createdAt: 0,
  updatedAt: 0
}

function projectHerdrActivation(
  store: Store,
  requestedHostId: ExecutionHostId
): HerdrPtyTargetResolver {
  return async (
    opts: PtySpawnOptions,
    persistedIdentity: HerdrPtyIdentity | null
  ): Promise<HerdrPtyTarget | null> => {
    const worktreeId = opts.worktreeId ?? persistedIdentity?.worktreeId ?? null
    const tabId = opts.tabId ?? persistedIdentity?.tabId ?? null
    const leafId = opts.paneKey
      ? extractLeafIdFromPaneKey(opts.paneKey)
      : (persistedIdentity?.leafId ?? null)

    if (!worktreeId || !tabId || !leafId) {
      return null
    }

    const session = store.getWorkspaceSession()
    const isFloating = worktreeId === FLOATING_TERMINAL_WORKTREE_ID

    let project: Project
    let worktrees: HerdrWorktreeDescriptor[]

    if (isFloating) {
      project = FLOATING_PROJECT
      // Why: reconcile only creates panes for graph worktrees; a floating
      // terminal has no filesystem checkout, so synthesize one rooted at the
      // spawn cwd so workspace.create/ensureTabLayout materialize its pane.
      worktrees = [
        {
          id: worktreeId,
          path: opts.cwd ?? '/',
          displayName: `Floating ${tabId}`
        }
      ]
    } else {
      const parsed = splitWorktreeIdForFilesystem(worktreeId)
      if (!parsed) {
        return null
      }
      project = resolveProject(store, worktreeId, persistedIdentity)
      const repoPath = repoPathForWorktree(store, worktreeId)
      worktrees = collectProjectWorktrees(store, project, {
        id: worktreeId,
        path: parsed.worktreePath,
        displayName: basename(parsed.worktreePath),
        ...(repoPath ? { repoPath } : {})
      })
    }

    const persistedLayout = session.terminalLayoutsByTabId[tabId]
    const resolvedLayout = resolveLayout(leafId, opts.terminalLayout, persistedLayout)

    // Why: floating and attach-only spawns can arrive before the workspace
    // session lists the tab. Synthesize that tab so ensureTabLayout can mint
    // the pane. The title is the tab id so each adopted pane stays distinct.
    const existingTabs = session.tabsByWorktree[worktreeId] ?? []
    const sessionTab = existingTabs.find((tab) => tab.id === tabId)
    const syntheticTab: TerminalTab = sessionTab ?? {
      id: tabId,
      ptyId: null,
      worktreeId,
      title: tabId,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    const tabsByWorktreeId = {
      ...session.tabsByWorktree,
      [worktreeId]: sessionTab ? existingTabs : [...existingTabs, syntheticTab]
    }

    const hostId = resolveSpawnHostId(requestedHostId, store.getWorktreeMeta?.(worktreeId)?.hostId)
    if (!projectWantsHerdr(project, store.getSettings().terminalBackendDefault ?? 'orca', hostId)) {
      return null
    }

    return {
      activateHerdr: () => {
        commitHerdrHostActivation(store, project.id, hostId)
      },
      legacyMigrationWorktreeIds: worktrees.map((entry) => entry.id),
      project,
      graph: {
        project,
        worktrees,
        tabsByWorktreeId,
        layoutsByTabId: {
          ...session.terminalLayoutsByTabId,
          [tabId]: resolvedLayout
        }
      },
      identity: {
        version: 2,
        hostId,
        projectId: project.id,
        worktreeId,
        tabId,
        leafId
      }
    }
  }
}

export function createLocalHerdrPtyTargetResolver(store: Store): HerdrPtyTargetResolver {
  return projectHerdrActivation(store, LOCAL_EXECUTION_HOST_ID)
}

export function createHerdrPtyTargetResolver(
  store: Store,
  hostId: ExecutionHostId
): HerdrPtyTargetResolver {
  return projectHerdrActivation(store, hostId)
}
