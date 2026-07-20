import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { Project } from '../../shared/types'
import type { Store } from '../persistence'
import { createLocalHerdrPtyTargetResolver } from './herdr-project-pty-target'

const leafId = '22222222-2222-4222-8222-222222222222'

function floatingSpawnOptions() {
  return {
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    tabId: 'floating-tab',
    paneKey: `floating-tab:${leafId}`
  }
}

describe('Herdr PTY target resolution', () => {
  it('leaves floating terminals on Orca when Herdr is not selected', async () => {
    const store = {
      getSettings: () => ({ terminalBackendDefault: 'orca' }),
      getProjects: () => [],
      getWorkspaceSession: () => ({ tabsByWorktree: {}, terminalLayoutsByTabId: {} })
    } as unknown as Store

    const target = await createLocalHerdrPtyTargetResolver(store)(floatingSpawnOptions(), null)

    expect(target).toBeNull()
  })

  it('routes floating terminals through the reserved session when Herdr is selected', async () => {
    const store = {
      getSettings: () => ({ terminalBackendDefault: 'herdr' }),
      getProjects: () => [],
      getWorkspaceSession: () => ({ tabsByWorktree: {}, terminalLayoutsByTabId: {} })
    } as unknown as Store

    const target = await createLocalHerdrPtyTargetResolver(store)(floatingSpawnOptions(), null)

    expect(target?.project.herdrSessionName).toBe('orca-global')
    expect(target?.identity).toMatchObject({
      projectId: 'orca-global',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      tabId: 'floating-tab',
      leafId
    })
  })

  it('uses the renderer layout when main persistence has not observed a new split yet', async () => {
    const newLeafId = '33333333-3333-4333-8333-333333333333'
    const staleLayout = {
      root: { type: 'leaf' as const, leafId },
      activeLeafId: leafId,
      expandedLeafId: null
    }
    const currentLayout = {
      root: {
        type: 'split' as const,
        direction: 'horizontal' as const,
        ratio: 0.5,
        first: staleLayout.root,
        second: { type: 'leaf' as const, leafId: newLeafId }
      },
      activeLeafId: newLeafId,
      expandedLeafId: null
    }
    const store = {
      getSettings: () => ({ terminalBackendDefault: 'herdr' }),
      getProjects: () => [],
      getWorkspaceSession: () => ({
        tabsByWorktree: {},
        terminalLayoutsByTabId: { 'floating-tab': staleLayout }
      })
    } as unknown as Store

    const target = await createLocalHerdrPtyTargetResolver(store)(
      {
        ...floatingSpawnOptions(),
        paneKey: `floating-tab:${newLeafId}`,
        terminalLayout: currentLayout
      },
      null
    )

    expect(target?.graph.layoutsByTabId['floating-tab']).toEqual(currentLayout)
  })

  it('uses the fuller persisted layout when renderer still reports only the new pane', async () => {
    const newLeafId = '33333333-3333-4333-8333-333333333333'
    const rendererLayout = {
      root: { type: 'leaf' as const, leafId: newLeafId },
      activeLeafId: newLeafId,
      expandedLeafId: null
    }
    const persistedLayout = {
      root: {
        type: 'split' as const,
        direction: 'horizontal' as const,
        ratio: 0.5,
        first: { type: 'leaf' as const, leafId },
        second: rendererLayout.root
      },
      activeLeafId: newLeafId,
      expandedLeafId: null
    }
    const store = {
      getSettings: () => ({ terminalBackendDefault: 'herdr' }),
      getProjects: () => [],
      getWorkspaceSession: () => ({
        tabsByWorktree: {},
        terminalLayoutsByTabId: { 'floating-tab': persistedLayout }
      })
    } as unknown as Store

    const target = await createLocalHerdrPtyTargetResolver(store)(
      {
        ...floatingSpawnOptions(),
        paneKey: `floating-tab:${newLeafId}`,
        terminalLayout: rendererLayout
      },
      null
    )

    expect(target?.graph.layoutsByTabId['floating-tab']).toEqual(persistedLayout)
  })

  it('synthesizes the spawning pane when the renderer layout is not materialized yet', async () => {
    const store = {
      getSettings: () => ({ terminalBackendDefault: 'herdr' }),
      getProjects: () => [],
      getWorkspaceSession: () => ({ tabsByWorktree: {}, terminalLayoutsByTabId: {} })
    } as unknown as Store

    const target = await createLocalHerdrPtyTargetResolver(store)(
      {
        ...floatingSpawnOptions(),
        terminalLayout: { root: null, activeLeafId: null, expandedLeafId: null }
      },
      null
    )

    expect(target?.graph.layoutsByTabId['floating-tab'].root).toEqual({ type: 'leaf', leafId })
  })

  it('keeps freshly resolved host and global project identity authoritative on reattach', async () => {
    const store = {
      getSettings: () => ({ terminalBackendDefault: 'herdr' }),
      getProjects: () => [],
      getWorkspaceSession: () => ({ tabsByWorktree: {}, terminalLayoutsByTabId: {} })
    } as unknown as Store

    const target = await createLocalHerdrPtyTargetResolver(store)(floatingSpawnOptions(), {
      hostId: 'ssh:stale-host',
      projectId: 'stale-project',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      tabId: 'floating-tab',
      leafId
    })

    expect(target?.identity).toMatchObject({ hostId: 'local', projectId: 'orca-global' })
  })

  it('resolves persisted project identity before metadata and repository fallbacks', async () => {
    const worktreeId = 'repo-1::/tmp/worktree'
    const makeProject = (id: string, sourceRepoIds: string[]): Project => ({
      id,
      displayName: id,
      badgeColor: '#000000',
      sourceRepoIds,
      createdAt: 1,
      updatedAt: 1
    })
    const projects = [
      makeProject('repo-fallback', ['repo-1']),
      makeProject('metadata-project', []),
      makeProject('persisted-project', [])
    ]
    const store = {
      getSettings: () => ({ terminalBackendDefault: 'herdr' }),
      getProjects: () => projects,
      getWorktreeMeta: () => ({ projectId: 'metadata-project', hostId: 'local' }),
      getWorkspaceSession: () => ({ tabsByWorktree: {}, terminalLayoutsByTabId: {} }),
      updateProject: vi.fn()
    } as unknown as Store

    const target = await createLocalHerdrPtyTargetResolver(store)(
      {
        cols: 80,
        rows: 24,
        cwd: '/tmp/worktree',
        worktreeId,
        tabId: 'tab-1',
        paneKey: `tab-1:${leafId}`
      },
      {
        hostId: 'ssh:stale-host',
        projectId: 'persisted-project',
        worktreeId,
        tabId: 'tab-1',
        leafId
      }
    )

    expect(target?.project.id).toBe('persisted-project')
    expect(target?.identity).toMatchObject({ hostId: 'local', projectId: 'persisted-project' })
  })
})
