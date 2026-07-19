import {
  getWorktreePathBasenameFromId,
  splitWorktreeIdForFilesystem
} from '../../shared/worktree-id'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../shared/types'
import type { Project } from '../../shared/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { isEphemeralSetupTerminalWorktreeId } from '../../shared/ephemeral-setup-terminal-worktree-id'
import type { Store } from '../persistence'
import type { HerdrPtyIdentity, HerdrPtyTargetResolver } from './herdr-pty-provider'

function resolveIdentity(
  opts: Parameters<HerdrPtyTargetResolver>[0],
  persisted: HerdrPtyIdentity | null
): Omit<HerdrPtyIdentity, 'projectId' | 'hostId'> | null {
  if (persisted) return persisted
  const pane = opts.paneKey ? parsePaneKey(opts.paneKey) : null
  const worktreeId = opts.worktreeId
  const tabId = opts.tabId ?? pane?.tabId
  const leafId = pane?.leafId
  if (!worktreeId || !tabId || !leafId) return null
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

export function createLocalHerdrPtyTargetResolver(store: Store): HerdrPtyTargetResolver {
  return createHerdrPtyTargetResolver(store, 'local')
}

export function createHerdrPtyTargetResolver(store: Store, hostId: string): HerdrPtyTargetResolver {
  return async (opts, persistedIdentity) => {
    const partial = resolveIdentity(opts, persistedIdentity)
    if (!partial) return null
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
      const session = store.getWorkspaceSession(hostId)
      const existingTabs = session.tabsByWorktree[partial.worktreeId] ?? []
      const targetTab =
        existingTabs.find((candidate) => candidate.id === partial.tabId) ??
        syntheticTab(partial, opts.cwd)
      const tabs = existingTabs.some((candidate) => candidate.id === targetTab.id)
        ? existingTabs
        : [...existingTabs, targetTab]
      const layout = session.terminalLayoutsByTabId[targetTab.id] ?? syntheticLayout(partial.leafId)
      return {
        project,
        identity: { hostId, projectId: project.id, ...partial },
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
    if (!parsed) return null
    const meta = store.getWorktreeMeta(partial.worktreeId)
    if (meta?.hostId && meta.hostId !== hostId) return null
    const project = store
      .getProjects()
      .find(
        (candidate) =>
          candidate.id === persistedIdentity?.projectId ||
          candidate.id === meta?.projectId ||
          candidate.sourceRepoIds.includes(parsed.repoId)
      )
    if (!project) return null

    const session = store.getWorkspaceSession(hostId)
    const existingTabs = session.tabsByWorktree[partial.worktreeId] ?? []
    const targetTab =
      existingTabs.find((candidate) => candidate.id === partial.tabId) ??
      syntheticTab(partial, opts.cwd)
    const tabs = existingTabs.some((candidate) => candidate.id === targetTab.id)
      ? existingTabs
      : [...existingTabs, targetTab]
    const layout = session.terminalLayoutsByTabId[targetTab.id] ?? syntheticLayout(partial.leafId)
    const identity: HerdrPtyIdentity = {
      hostId,
      projectId: project.id,
      ...partial
    }

    return {
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
