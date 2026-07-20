import {
  getWorktreePathBasenameFromId,
  splitWorktreeIdForFilesystem
} from '../../shared/worktree-id'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../shared/types'
import type { Project } from '../../shared/types'
import { resolveDesiredTerminalBackend } from '../../shared/terminal-backend'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { isEphemeralSetupTerminalWorktreeId } from '../../shared/ephemeral-setup-terminal-worktree-id'
import type { Store } from '../persistence'
import type { HerdrPtyIdentity, HerdrPtyTargetResolver } from './herdr-pty-provider'

function projectHerdrActivation(
  store: Store,
  project: Project,
  hostId: string
): { useHerdr: boolean; activateHerdr?: () => void } {
  const settings = store.getSettings()
  const activation = project.terminalBackendByHost?.[hostId]
  const desired = resolveDesiredTerminalBackend({
    globalDefault: settings.terminalBackendDefault ?? 'orca',
    preference: project.terminalBackendPreference ?? 'inherit',
    activation
  })
  if (desired !== 'herdr') {
    if (
      activation?.backend === 'herdr' &&
      store.getProjects().some((entry) => entry.id === project.id)
    ) {
      store.updateProject(project.id, {
        terminalBackendByHost: {
          ...project.terminalBackendByHost,
          [hostId]: { backend: 'orca', state: 'ready' }
        }
      })
    }
    return { useHerdr: false }
  }
  if (
    activation?.backend === 'herdr' ||
    !store.getProjects().some((entry) => entry.id === project.id)
  ) {
    return { useHerdr: true }
  }
  return {
    useHerdr: true,
    activateHerdr: () => {
      const current = store.getProjects().find((entry) => entry.id === project.id) ?? project
      store.updateProject(project.id, {
        terminalBackendByHost: {
          ...current.terminalBackendByHost,
          [hostId]: { backend: 'herdr', state: 'ready' }
        }
      })
    }
  }
}

function resolveIdentity(
  opts: Parameters<HerdrPtyTargetResolver>[0],
  persisted: HerdrPtyIdentity | null
): Omit<HerdrPtyIdentity, 'projectId' | 'hostId'> | null {
  if (persisted) {
    return persisted
  }
  const pane = opts.paneKey ? parsePaneKey(opts.paneKey) : null
  const worktreeId = opts.worktreeId
  const tabId = opts.tabId ?? pane?.tabId
  const leafId = pane?.leafId
  if (!worktreeId || !tabId || !leafId) {
    return null
  }
  return { worktreeId, tabId, leafId }
}

function syntheticTab(
  identity: Omit<HerdrPtyIdentity, 'projectId' | 'hostId'>,
  cwd: string | undefined
): TerminalTab {
  return {
    id: identity.tabId,
    ptyId: null,
    worktreeId: identity.worktreeId,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: Date.now(),
    ...(cwd ? { startupCwd: cwd } : {})
  }
}

function syntheticLayout(leafId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null
  }
}

function layoutContainsLeaf(node: TerminalPaneLayoutNode | null, leafId: string): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return layoutContainsLeaf(node.first, leafId) || layoutContainsLeaf(node.second, leafId)
}

function layoutLeafCount(node: TerminalPaneLayoutNode | null): number {
  if (!node) {
    return 0
  }
  if (node.type === 'leaf') {
    return 1
  }
  return layoutLeafCount(node.first) + layoutLeafCount(node.second)
}

function resolveLayout(
  candidate: TerminalLayoutSnapshot | undefined,
  persisted: TerminalLayoutSnapshot | undefined,
  leafId: string
): TerminalLayoutSnapshot {
  const validLayouts = [candidate, persisted].filter((layout): layout is TerminalLayoutSnapshot =>
    Boolean(layout && layoutContainsLeaf(layout.root, leafId))
  )
  if (validLayouts.length > 0) {
    return validLayouts.reduce((fullest, layout) =>
      layoutLeafCount(layout.root) > layoutLeafCount(fullest.root) ? layout : fullest
    )
  }
  return syntheticLayout(leafId)
}

export function createLocalHerdrPtyTargetResolver(store: Store): HerdrPtyTargetResolver {
  return createHerdrPtyTargetResolver(store, 'local')
}

export function createHerdrPtyTargetResolver(store: Store, hostId: string): HerdrPtyTargetResolver {
  return async (opts, persistedIdentity) => {
    const partial = resolveIdentity(opts, persistedIdentity)
    if (!partial) {
      return null
    }
    const globalSurface =
      partial.worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
      isEphemeralSetupTerminalWorktreeId(partial.worktreeId)
    if (globalSurface) {
      const project: Project = {
        id: 'orca-global',
        displayName: 'Orca Global',
        badgeColor: '#000000',
        sourceRepoIds: [],
        herdrSessionName: 'orca-global',
        createdAt: 0,
        updatedAt: 0
      }
      if (!projectHerdrActivation(store, project, hostId).useHerdr) {
        return null
      }
      const session = store.getWorkspaceSession(hostId)
      const existingTabs = session.tabsByWorktree[partial.worktreeId] ?? []
      const targetTab =
        existingTabs.find((candidate) => candidate.id === partial.tabId) ??
        syntheticTab(partial, opts.cwd)
      const tabs = existingTabs.some((candidate) => candidate.id === targetTab.id)
        ? existingTabs
        : [...existingTabs, targetTab]
      const layout = resolveLayout(
        opts.terminalLayout,
        session.terminalLayoutsByTabId[targetTab.id],
        partial.leafId
      )
      return {
        project,
        identity: { ...partial, hostId, projectId: project.id },
        graph: {
          project,
          worktrees: [
            {
              id: partial.worktreeId,
              instanceId: partial.worktreeId,
              path: opts.cwd ?? '.',
              displayName: isEphemeralSetupTerminalWorktreeId(partial.worktreeId)
                ? 'Setup'
                : 'Global Terminal'
            }
          ],
          tabsByWorktreeId: { [partial.worktreeId]: tabs },
          layoutsByTabId: {
            ...session.terminalLayoutsByTabId,
            [targetTab.id]: layout
          }
        }
      }
    }
    const parsed = splitWorktreeIdForFilesystem(partial.worktreeId)
    if (!parsed) {
      return null
    }
    const meta = store.getWorktreeMeta(partial.worktreeId)
    if (meta?.hostId && meta.hostId !== hostId) {
      return null
    }
    const projects = store.getProjects()
    const project =
      (persistedIdentity?.projectId
        ? projects.find((candidate) => candidate.id === persistedIdentity.projectId)
        : undefined) ??
      (meta?.projectId
        ? projects.find((candidate) => candidate.id === meta.projectId)
        : undefined) ??
      projects.find((candidate) => candidate.sourceRepoIds.includes(parsed.repoId))
    if (!project) {
      return null
    }
    const herdrActivation = projectHerdrActivation(store, project, hostId)
    if (!herdrActivation.useHerdr) {
      return null
    }

    const session = store.getWorkspaceSession(hostId)
    const existingTabs = session.tabsByWorktree[partial.worktreeId] ?? []
    const targetTab =
      existingTabs.find((candidate) => candidate.id === partial.tabId) ??
      syntheticTab(partial, opts.cwd)
    const tabs = existingTabs.some((candidate) => candidate.id === targetTab.id)
      ? existingTabs
      : [...existingTabs, targetTab]
    const layout = resolveLayout(
      opts.terminalLayout,
      session.terminalLayoutsByTabId[targetTab.id],
      partial.leafId
    )
    const identity: HerdrPtyIdentity = {
      ...partial,
      hostId,
      projectId: project.id
    }

    return {
      ...(herdrActivation.activateHerdr
        ? {
            activateHerdr: herdrActivation.activateHerdr,
            legacyMigrationWorktreeIds: [partial.worktreeId]
          }
        : {}),
      project,
      identity,
      graph: {
        project,
        worktrees: [
          {
            id: partial.worktreeId,
            instanceId: meta?.instanceId,
            path: parsed.worktreePath,
            displayName:
              meta?.displayName ??
              getWorktreePathBasenameFromId(partial.worktreeId) ??
              parsed.worktreePath
          }
        ],
        tabsByWorktreeId: { [partial.worktreeId]: tabs },
        layoutsByTabId: {
          ...session.terminalLayoutsByTabId,
          [targetTab.id]: layout
        }
      }
    }
  }
}
