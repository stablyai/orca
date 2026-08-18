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
import { ORCA_BINDING_TOKEN, orcaPaneBinding, orcaWorkspaceBinding } from './herdr-binding-metadata'

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

function singleLeafGraph() {
  return {
    project: project(),
    worktrees: [
      {
        id: 'worktree-1',
        instanceId: 'instance-1',
        path: '/repo',
        displayName: 'repo'
      }
    ],
    tabsByWorktreeId: { 'worktree-1': [tab()] },
    layoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf' as const, leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null
      }
    }
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
      if (method === 'workspace.get') {
        const id = (params as { workspace_id?: string }).workspace_id
        const workspace = snapshot.workspaces.find((candidate) => candidate.workspace_id === id)
        return { id: 'workspace-get', result: { workspace: workspace ?? { workspace_id: id } } }
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
        const input = params as { pane_id: string; tokens: Record<string, string | null> }
        const pane = snapshot.panes.find((candidate) => candidate.pane_id === input.pane_id)
        if (pane) {
          const tokens = { ...pane.tokens }
          for (const [key, value] of Object.entries(input.tokens ?? {})) {
            if (value === null) {
              delete tokens[key]
            } else {
              tokens[key] = value
            }
          }
          pane.tokens = tokens
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
    expect(openParams).toMatchObject({ cwd: '/repo-root', path: '/repo', focus: false })
    expect(host.snapshot.workspaces).toHaveLength(1)
    expect(host.snapshot.panes).toHaveLength(2)
    expect(manager.getPaneId(herdrSessionNameForProject(project()), 'project-1', 'leaf-1')).toBe(
      'w1:p1'
    )
    expect(manager.getPaneId(herdrSessionNameForProject(project()), 'project-1', 'leaf-2')).toBe(
      'w1:p2'
    )
  })

  it('adopts a uniquely checked-out workspace even when its orca token is stale', async () => {
    const host = stockTransport({
      workspaces: [
        {
          workspace_id: 'w7',
          label: 'repo',
          worktree: { checkout_path: '/repo' },
          tokens: { [ORCA_BINDING_TOKEN]: 'stale-from-previous-project' }
        }
      ]
    })
    const manager = new HerdrRuntimeManager(host.transport)
    await manager.reconcileProjectHost(graph())

    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'workspace.create')
    ).toHaveLength(0)
    expect(host.snapshot.workspaces).toHaveLength(1)
    expect(host.snapshot.workspaces[0].workspace_id).toBe('w7')
    expect(host.snapshot.workspaces[0].tokens?.[ORCA_BINDING_TOKEN]).toBe(
      orcaWorkspaceBinding('project-1', {
        id: 'worktree-1',
        instanceId: 'instance-1',
        path: '/repo',
        displayName: 'repo'
      })
    )
  })

  it('adopts an unbound restored workspace by cwd after a herdr restart', async () => {
    const host = stockTransport({
      workspaces: [{ workspace_id: 'w-restored', label: 'repo', cwd: '/repo' }]
    })
    const manager = new HerdrRuntimeManager(host.transport)
    await manager.reconcileProjectHost(graph())

    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'workspace.create')
    ).toHaveLength(0)
    expect(host.snapshot.workspaces).toHaveLength(1)
    expect(host.snapshot.workspaces[0].workspace_id).toBe('w-restored')
    expect(host.snapshot.workspaces[0].tokens?.[ORCA_BINDING_TOKEN]).toBeTruthy()
  })

  it('reclaims restored split panes after tokens drop without rematerializing', async () => {
    const host = stockTransport()
    const manager = new HerdrRuntimeManager(host.transport)
    await manager.reconcileProjectHost(graph())
    const session = herdrSessionNameForProject(project())
    const leaf1 = manager.getPaneId(session, 'project-1', 'leaf-1')
    const leaf2 = manager.getPaneId(session, 'project-1', 'leaf-2')
    expect(leaf1).toBeTruthy()
    expect(leaf2).toBeTruthy()

    for (const pane of host.snapshot.panes) {
      delete pane.tokens
    }
    for (const workspace of host.snapshot.workspaces) {
      delete workspace.tokens
    }
    host.requestMock.mockClear()
    await manager.reconcileProjectHost(graph())

    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'workspace.create')
    ).toHaveLength(0)
    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'pane.split')
    ).toHaveLength(0)
    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'layout.apply')
    ).toHaveLength(0)
    expect(manager.getPaneId(session, 'project-1', 'leaf-1')).toBe(leaf1)
    expect(manager.getPaneId(session, 'project-1', 'leaf-2')).toBe(leaf2)
  })

  it('reclaims persisted split panes on a fresh manager without rematerializing', async () => {
    const host = stockTransport({
      workspaces: [{ workspace_id: 'w1', label: 'repo', cwd: '/repo' }],
      tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'Terminal' }],
      panes: [
        { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' },
        { pane_id: 'w1:p3', tab_id: 'w1:t1', workspace_id: 'w1' }
      ]
    })
    const manager = new HerdrRuntimeManager(host.transport)
    await manager.reconcileProjectHost({
      ...graph(),
      persistedPaneIdsByLeafId: { 'leaf-1': 'w1:p1', 'leaf-2': 'w1:p3' }
    })

    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'workspace.create')
    ).toHaveLength(0)
    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'pane.split')
    ).toHaveLength(0)
    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'layout.apply')
    ).toHaveLength(0)
    expect(manager.getPaneId(herdrSessionNameForProject(project()), 'project-1', 'leaf-1')).toBe(
      'w1:p1'
    )
    expect(manager.getPaneId(herdrSessionNameForProject(project()), 'project-1', 'leaf-2')).toBe(
      'w1:p3'
    )
  })

  it('creates the project root with workspace.create even when repoPath is set', async () => {
    const host = stockTransport()
    const manager = new HerdrRuntimeManager(host.transport)
    await manager.reconcileProjectHost({
      ...graph('/repo'),
      worktrees: [
        {
          id: 'worktree-1',
          instanceId: 'instance-1',
          path: '/repo',
          displayName: 'repo',
          repoPath: '/repo'
        }
      ]
    })

    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'worktree.open')
    ).toHaveLength(0)
    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'workspace.create')
    ).toHaveLength(1)
  })

  it('keeps both project graphs when they share the orca session', async () => {
    const host = stockTransport()
    const manager = new HerdrRuntimeManager(host.transport, () => 'orca')
    const second = {
      ...graph(),
      project: { ...project(), id: 'project-2', displayName: 'Other' },
      worktrees: [
        {
          id: 'worktree-2',
          instanceId: 'instance-2',
          path: '/other',
          displayName: 'other'
        }
      ],
      tabsByWorktreeId: { 'worktree-2': [] },
      layoutsByTabId: {}
    }
    await manager.reconcileProjectHost(graph())
    await manager.reconcileProjectHost(second)

    expect(manager.listSessionNames()).toEqual(['orca'])
    expect(manager.getPaneId('orca', 'project-1', 'leaf-1')).toBe('w1:p1')
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

  it('reclaims a duplicate stock pane binding and imports the extra herdr tabs', async () => {
    const leafId = '9ff5d61c-7a93-445e-8fe9-4783e56808d5'
    const worktree = {
      id: 'worktree-1',
      instanceId: 'instance-1',
      path: '/repo',
      displayName: 'repo'
    }
    const workspaceBinding = orcaWorkspaceBinding('project-1', worktree)
    const paneBinding = orcaPaneBinding('project-1', leafId)
    const host = stockTransport({
      workspaces: [
        {
          workspace_id: 'w7',
          label: 'repo',
          tokens: { [ORCA_BINDING_TOKEN]: workspaceBinding },
          worktree: { checkout_path: '/repo' }
        }
      ],
      tabs: [
        { tab_id: 'w7:t1', workspace_id: 'w7', label: 'Terminal' },
        { tab_id: 'w7:t2', workspace_id: 'w7', label: 'logs' },
        { tab_id: 'w7:t3', workspace_id: 'w7', label: 'git' }
      ],
      panes: [
        {
          pane_id: 'w7:p1',
          tab_id: 'w7:t1',
          workspace_id: 'w7',
          tokens: { [ORCA_BINDING_TOKEN]: paneBinding }
        },
        {
          pane_id: 'w7:p2',
          tab_id: 'w7:t2',
          workspace_id: 'w7',
          tokens: { [ORCA_BINDING_TOKEN]: paneBinding }
        },
        { pane_id: 'w7:p3', tab_id: 'w7:t3', workspace_id: 'w7' }
      ]
    })
    const persist = vi.fn()
    const present = vi.fn()
    const manager = new HerdrRuntimeManager(host.transport, undefined, undefined, {
      persist,
      present
    })

    await expect(
      manager.reconcileProjectHost({
        ...singleLeafGraph(),
        layoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId },
            activeLeafId: leafId,
            expandedLeafId: null
          }
        }
      })
    ).resolves.toBeTruthy()

    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'workspace.create')
    ).toHaveLength(0)
    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'tab.create')
    ).toHaveLength(0)
    expect(manager.getPaneId(herdrSessionNameForProject(project()), 'project-1', leafId)).toBe(
      'w7:p1'
    )
    expect(
      host.snapshot.panes.filter((pane) => pane.tokens?.[ORCA_BINDING_TOKEN] === paneBinding)
    ).toHaveLength(1)
    expect(
      host.snapshot.panes.find((pane) => pane.pane_id === 'w7:p2')?.tokens?.[ORCA_BINDING_TOKEN]
    ).not.toBe(paneBinding)
    expect(persist.mock.calls.map((call) => call[0].paneId).sort()).toEqual(['w7:p2', 'w7:p3'])
    expect(present).toHaveBeenCalledTimes(2)
  })

  it('imports an unbound sibling pane through surface sync persist and present', async () => {
    const host = stockTransport()
    const persist = vi.fn()
    const present = vi.fn()
    const manager = new HerdrRuntimeManager(host.transport, undefined, undefined, {
      persist,
      present
    })
    await manager.reconcileProjectHost(singleLeafGraph())
    expect(persist).not.toHaveBeenCalled()
    expect(present).not.toHaveBeenCalled()

    const workspace = host.snapshot.workspaces[0]
    const tab = host.snapshot.tabs[0]
    expect(workspace).toBeTruthy()
    expect(tab).toBeTruthy()
    host.snapshot.panes.push({
      pane_id: 'w1:p-imported',
      tab_id: tab.tab_id,
      workspace_id: workspace.workspace_id
    })

    await manager.reconcileProjectHost(singleLeafGraph())
    expect(persist).toHaveBeenCalledTimes(1)
    expect(present).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0]).toMatchObject({
      paneId: 'w1:p-imported',
      tabId: 'tab-1',
      splitFromLeafId: 'leaf-1'
    })
    expect(present.mock.calls[0][0]).toEqual(persist.mock.calls[0][0])
  })

  it('adopts a leftover materialized herdr tab instead of minting a second orca tab', async () => {
    const leafId = 'existing-leaf'
    const worktree = {
      id: 'worktree-1',
      instanceId: 'instance-1',
      path: '/repo',
      displayName: 'repo'
    }
    const workspaceBinding = orcaWorkspaceBinding('project-1', worktree)
    const host = stockTransport({
      workspaces: [
        {
          workspace_id: 'w1',
          label: 'repo',
          tokens: { [ORCA_BINDING_TOKEN]: workspaceBinding }
        }
      ],
      tabs: [
        {
          tab_id: 'w1:t9',
          workspace_id: 'w1',
          label: 'leaf-3542a4f8-ea86-4908-9dbd-40d2fc3bcf4'
        }
      ],
      panes: [{ pane_id: 'w1:p9', tab_id: 'w1:t9', workspace_id: 'w1' }]
    })
    const persist = vi.fn()
    const present = vi.fn()
    const manager = new HerdrRuntimeManager(host.transport, undefined, undefined, {
      persist,
      present
    })

    await manager.reconcileProjectHost({
      ...singleLeafGraph(),
      tabsByWorktreeId: {
        'worktree-1': [{ ...tab(), title: '1' }]
      },
      layoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null
        }
      }
    })

    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'tab.create')
    ).toHaveLength(0)
    expect(present).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    expect(manager.getPaneId(herdrSessionNameForProject(project()), 'project-1', leafId)).toBe(
      'w1:p9'
    )
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
      emit: (event: string, data: Record<string, unknown> = {}, sessionName?: string) =>
        listener?.({
          event,
          data: { type: event, ...data },
          ...(sessionName ? { sessionName } : {})
        }),
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

  it('notifies pane.exited before the pane leaves the snapshot', async () => {
    const host = eventfulTransport()
    const onPaneExited = vi.fn()
    const manager = new HerdrRuntimeManager(
      host.transport,
      undefined,
      undefined,
      undefined,
      onPaneExited
    )
    await manager.reconcileProjectHost(graph())

    const sessionName = herdrSessionNameForProject(project())
    host.emit('pane_exited', { pane_id: 'w1:p1' })
    expect(onPaneExited).toHaveBeenCalledWith(sessionName, 'w1:p1')

    host.emit('pane.exited', { pane_id: 'w1:p2' }, 'other')
    expect(onPaneExited).toHaveBeenCalledWith('other', 'w1:p2')
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

  it('renames the Orca tab when a later snapshot changes the Herdr tab label', async () => {
    const host = eventfulTransport()
    const presentAction = vi.fn()
    const manager = new HerdrRuntimeManager(host.transport, undefined, undefined, {
      persist: vi.fn(),
      presentAction
    })
    await manager.reconcileProjectHost(graph())
    expect(host.snapshot.tabs[0]).toBeTruthy()
    const renamed = structuredClone(host.snapshot)
    renamed.tabs[0] = { ...renamed.tabs[0], label: 'renamed-from-tui' }
    const baseRequest = host.requestMock.getMockImplementation()!
    host.requestMock.mockImplementation(async (session, method, params) => {
      if (method === 'session.snapshot') {
        return { id: 'snapshot', result: { snapshot: structuredClone(renamed) } }
      }
      return baseRequest(session, method, params)
    })
    host.emit('tab.renamed')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(presentAction).toHaveBeenCalledWith({
      kind: 'rename',
      tabId: 'tab-1',
      title: 'renamed-from-tui'
    })
  })
})
