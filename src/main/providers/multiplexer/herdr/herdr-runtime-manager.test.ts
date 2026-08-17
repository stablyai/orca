import { describe, expect, it, vi } from 'vitest'
import type { Project } from '../../../../shared/project-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { herdrSessionNameForProject } from '../../../../shared/herdr-session-identity'
import type {
  HerdrHostTransport,
  HerdrResponse,
  HerdrSessionSnapshot
} from './herdr-runtime-contract'
import { HerdrRuntimeManager } from './herdr-runtime-manager'
import { ORCA_BINDING_TOKEN } from './herdr-binding-metadata'

function project(): Project {
  return {
    id: 'project-1',
    displayName: 'Project',
    badgeColor: '#000',
    sourceRepoIds: ['repo-1'],
    createdAt: 1,
    updatedAt: 1
  }
}

function tab(): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'worktree-1',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function graphWithSessionName(herdrSessionName: string) {
  return {
    ...graph(),
    project: { ...project(), herdrSessionName }
  }
}

function graph(repoPath?: string) {
  return {
    project: project(),
    worktrees: [
      {
        id: 'worktree-1',
        instanceId: 'instance-1',
        path: '/repo',
        displayName: 'repo',
        ...(repoPath ? { repoPath } : {})
      }
    ],
    tabsByWorktreeId: { 'worktree-1': [tab()] },
    layoutsByTabId: {
      'tab-1': {
        root: {
          type: 'split' as const,
          direction: 'vertical' as const,
          ratio: 0.5,
          first: { type: 'leaf' as const, leafId: 'leaf-1' },
          second: { type: 'leaf' as const, leafId: 'leaf-2' }
        },
        activeLeafId: 'leaf-1',
        expandedLeafId: null
      }
    }
  }
}

function stockTransport(
  initial?: Partial<HerdrSessionSnapshot>,
  opts: { alreadyOpen?: boolean; worktreeOpenError?: string } = {}
) {
  const snapshot: HerdrSessionSnapshot = {
    version: '0.7.5',
    protocol: 18,
    workspaces: [],
    tabs: [],
    panes: [],
    layouts: [],
    agents: [],
    ...initial
  }
  const requestMock = vi.fn(
    async (_session: string, method: string, params: unknown): Promise<HerdrResponse<unknown>> => {
      if (method === 'session.snapshot') {
        return { id: 'snapshot', result: { snapshot } }
      }
      if (method === 'workspace.create') {
        const workspace = { workspace_id: 'w1', label: 'repo' }
        const createdTab = { tab_id: 'w1:t1', workspace_id: 'w1', label: 'Terminal' }
        const rootPane = { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }
        return {
          id: 'workspace',
          result: { workspace, tab: createdTab, root_pane: rootPane }
        }
      }
      if (method === 'worktree.open') {
        if (opts.worktreeOpenError) {
          return {
            id: 'worktree',
            error: { code: opts.worktreeOpenError, message: opts.worktreeOpenError }
          }
        }
        const path = (params as { path?: string }).path ?? '/repo'
        const workspace = { workspace_id: 'w1', label: 'repo', worktree: { checkout_path: path } }
        const createdTab = { tab_id: 'w1:t1', workspace_id: 'w1', label: '1' }
        const rootPane = { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }
        return {
          id: 'worktree',
          result: {
            workspace,
            tab: createdTab,
            root_pane: rootPane,
            already_open: opts.alreadyOpen ?? false
          }
        }
      }
      if (method === 'tab.create') {
        return {
          id: 'tab',
          result: {
            tab: { tab_id: 'w1:t1', workspace_id: 'w1', label: '1' },
            root_pane: { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }
          }
        }
      }
      if (method === 'pane.split') {
        return {
          id: 'split',
          result: {
            pane: { pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1' }
          }
        }
      }
      if (method === 'workspace.report_metadata') {
        const input = params as {
          workspace_id: string
          tokens: Record<string, string>
        }
        const workspace = snapshot.workspaces.find(
          (candidate) => candidate.workspace_id === input.workspace_id
        )
        if (workspace) {
          workspace.tokens = { ...workspace.tokens, ...input.tokens }
        }
        return { id: 'workspace-metadata', result: { type: 'ok' } }
      }
      if (method === 'pane.report_metadata') {
        const input = params as { pane_id: string; tokens: Record<string, string> }
        const pane = snapshot.panes.find((candidate) => candidate.pane_id === input.pane_id)
        if (pane) {
          pane.tokens = { ...pane.tokens, ...input.tokens }
        }
        return { id: 'pane-metadata', result: { type: 'ok' } }
      }
      throw new Error(`Unexpected stock method ${method}`)
    }
  )
  const request: HerdrHostTransport['request'] = async <T>(session, method, params) =>
    (await requestMock(session, method, params)) as HerdrResponse<T>
  return {
    snapshot,
    requestMock,
    transport: {
      ensureSession: vi.fn(async () => undefined),
      request
    } satisfies HerdrHostTransport
  }
}

describe('HerdrRuntimeManager stock reconciliation', () => {
  it('creates and tags a split without fork-only methods, then stays idempotent', async () => {
    const host = stockTransport()
    const manager = new HerdrRuntimeManager(host.transport)
    await manager.reconcileProjectHost(graph())
    await manager.reconcileProjectHost(graph())

    expect(host.snapshot.workspaces).toHaveLength(1)
    expect(host.snapshot.panes).toHaveLength(2)
    expect(manager.getPaneId(herdrSessionNameForProject(project()), 'project-1', 'leaf-1')).toBe(
      'w1:p1'
    )
    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'workspace.create')
    ).toHaveLength(1)
    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'pane.split')
    ).toHaveLength(1)
    expect(host.requestMock.mock.calls.map(([, method]) => method)).not.toContain('pane.bind')
  })

  it('reconciles into the shared Orca session when a sharedName is configured', async () => {
    const host = stockTransport()
    const manager = new HerdrRuntimeManager(host.transport, () => 'orca')
    await manager.reconcileProjectHost(graph())

    expect(host.snapshot.workspaces).toHaveLength(1)
    const sessions = host.requestMock.mock.calls.map(([session]) => session)
    expect(sessions.length).toBeGreaterThan(0)
    expect([...new Set(sessions)]).toEqual(['orca'])
    expect(host.transport.ensureSession).toHaveBeenCalledWith('orca')
  })

  it('lets a per-project override win over the shared session when both are set', async () => {
    const host = stockTransport()
    const manager = new HerdrRuntimeManager(host.transport, () => 'orca')
    await manager.reconcileProjectHost(graphWithSessionName('cdn-repo-session'))

    expect(host.requestMock.mock.calls.map(([session]) => session)).toContain('cdn-repo-session')
    expect(host.requestMock.mock.calls.map(([session]) => session)).not.toContain('orca')
  })

  it('refuses to guess between duplicate stock workspace candidates', async () => {
    const host = stockTransport({
      workspaces: [
        {
          workspace_id: 'w1',
          label: 'repo',
          worktree: { checkout_path: '/repo' }
        },
        {
          workspace_id: 'w2',
          label: 'repo',
          worktree: { checkout_path: '/repo' }
        }
      ]
    })
    const manager = new HerdrRuntimeManager(host.transport)
    await expect(manager.reconcileProjectHost(graph())).rejects.toMatchObject({
      code: 'herdr_binding_ambiguous'
    })
  })

  it('opens a git-backed checkout via stock worktree.open and binds the root pane', async () => {
    const host = stockTransport()
    const manager = new HerdrRuntimeManager(host.transport)
    await manager.reconcileProjectHost(graph('/repo-root'))

    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'worktree.open')
    ).toHaveLength(1)
    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'workspace.create')
    ).toHaveLength(0)
    const openParams = host.requestMock.mock.calls.find(
      ([, method]) => method === 'worktree.open'
    )?.[2] as { cwd: string; path: string; focus: boolean }
    expect(openParams).toMatchObject({ cwd: '/repo-root', path: '/repo', focus: true })
    expect(host.snapshot.workspaces).toHaveLength(1)
    expect(host.snapshot.panes).toHaveLength(2)
    expect(manager.getPaneId(herdrSessionNameForProject(project()), 'project-1', 'leaf-1')).toBe(
      'w1:p1'
    )
    expect(manager.getPaneId(herdrSessionNameForProject(project()), 'project-1', 'leaf-2')).toBe(
      'w1:p2'
    )
  })

  it('adopts an already-open worktree without duplicating the workspace', async () => {
    const host = stockTransport({}, { alreadyOpen: true })
    const manager = new HerdrRuntimeManager(host.transport)
    await manager.reconcileProjectHost(graph('/repo-root'))

    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'worktree.open')
    ).toHaveLength(1)
    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'workspace.create')
    ).toHaveLength(0)
    expect(host.snapshot.workspaces).toHaveLength(0)
  })

  it('falls back to workspace.create when worktree.open reports not_git_worktree', async () => {
    const host = stockTransport({}, { worktreeOpenError: 'not_git_worktree' })
    const manager = new HerdrRuntimeManager(host.transport)
    await manager.reconcileProjectHost(graph('/repo-root'))

    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'worktree.open')
    ).toHaveLength(1)
    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'workspace.create')
    ).toHaveLength(1)
    expect(manager.getPaneId(herdrSessionNameForProject(project()), 'project-1', 'leaf-1')).toBe(
      'w1:p1'
    )
  })

  it('never double-claims a pane binding when layout.apply re-materializes the tab', async () => {
    // Regresses the shape where layout.apply left two live panes with one orca_binding.
    let seq = 1000
    const host = stockTransport()
    const baseRequest = host.requestMock.getMockImplementation()!
    host.requestMock.mockImplementation(
      async (session: string, method: string, params: unknown) => {
        if (method !== 'layout.apply') {
          return baseRequest(session, method, params)
        }
        const workspaceId = (params as { workspace_id?: string }).workspace_id ?? 'w1'
        const tabId = `w1:apply-${++seq}`
        const first = { pane_id: `w1:p${++seq}`, tab_id: tabId, workspace_id: workspaceId }
        const second = { pane_id: `w1:p${++seq}`, tab_id: tabId, workspace_id: workspaceId }
        for (const pane of [first, second]) {
          host.snapshot.panes.push(pane)
        }
        host.snapshot.tabs.push({ tab_id: tabId, workspace_id: workspaceId, label: 'Terminal' })
        host.snapshot.layouts.push({
          workspace_id: workspaceId,
          tab_id: tabId,
          panes: [first, second].map((pane, i) => ({
            pane_id: pane.pane_id,
            rect: { x: i === 0 ? 0 : 60, y: 0, width: 60, height: 40 },
            ...(i === 0 ? { focused: true } : {})
          }))
        })
        return {
          id: 'layout',
          result: {
            tab_id: tabId,
            workspace_id: workspaceId,
            layout: {
              workspace_id: workspaceId,
              tab_id: tabId,
              root: {
                type: 'split',
                direction: 'right',
                ratio: 0.5,
                first: { type: 'pane', pane_id: first.pane_id },
                second: { type: 'pane', pane_id: second.pane_id }
              }
            }
          }
        }
      }
    )

    const manager = new HerdrRuntimeManager(host.transport)
    await manager.reconcileProjectHost(graph())
    await manager.reconcileProjectHost(graph())

    const bindings = new Map<string, string>()
    for (const pane of host.snapshot.panes) {
      const token = pane.tokens?.[ORCA_BINDING_TOKEN]
      if (!token) {
        continue
      }
      const owner = bindings.get(token)
      expect(owner).toBeUndefined()
      bindings.set(token, pane.pane_id)
    }
    expect(bindings.size).toBe(2)
    expect(
      manager.getPaneId(herdrSessionNameForProject(project()), 'project-1', 'leaf-1')
    ).not.toBeNull()
    expect(
      manager.getPaneId(herdrSessionNameForProject(project()), 'project-1', 'leaf-2')
    ).not.toBeNull()
  })
})

describe('HerdrRuntimeManager event-driven reconcile', () => {
  function eventfulTransport(initial?: Partial<HerdrSessionSnapshot>) {
    const base = stockTransport(initial)
    let listener: ((event: { event: string; data: { type: string } }) => void) | null = null
    const transport: HerdrHostTransport = {
      ...base.transport,
      onEvent: (next) => {
        listener = next
        return () => {
          listener = null
        }
      },
      disconnect: vi.fn(async () => undefined)
    }
    return {
      ...base,
      transport,
      emit: (event: string) => listener?.({ event, data: { type: event } }),
      isSubscribed: () => listener !== null,
      disconnectSpy: transport.disconnect as ReturnType<typeof vi.fn>
    }
  }

  it('subscribes to events on reconcile and refreshes the snapshot on structural events', async () => {
    const host = eventfulTransport()
    const manager = new HerdrRuntimeManager(host.transport)
    await manager.reconcileProjectHost(graph())
    expect(host.isSubscribed()).toBe(true)

    const snapshotCallsBefore = host.requestMock.mock.calls.filter(
      ([, method]) => method === 'session.snapshot'
    ).length
    host.emit('pane.created')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const snapshotCallsAfter = host.requestMock.mock.calls.filter(
      ([, method]) => method === 'session.snapshot'
    ).length
    expect(snapshotCallsAfter).toBeGreaterThan(snapshotCallsBefore)
  })

  it('ignores non-structural events', async () => {
    const host = eventfulTransport()
    const manager = new HerdrRuntimeManager(host.transport)
    await manager.reconcileProjectHost(graph())

    const snapshotCallsBefore = host.requestMock.mock.calls.filter(
      ([, method]) => method === 'session.snapshot'
    ).length
    host.emit('badge_changed')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const snapshotCallsAfter = host.requestMock.mock.calls.filter(
      ([, method]) => method === 'session.snapshot'
    ).length
    expect(snapshotCallsAfter).toBe(snapshotCallsBefore)
  })

  it('unsubscribes and disconnects on dispose', async () => {
    const host = eventfulTransport()
    const manager = new HerdrRuntimeManager(host.transport)
    await manager.reconcileProjectHost(graph())
    expect(host.isSubscribed()).toBe(true)
    manager.dispose()
    expect(host.isSubscribed()).toBe(false)
    expect(host.disconnectSpy).toHaveBeenCalled()
  })
})
