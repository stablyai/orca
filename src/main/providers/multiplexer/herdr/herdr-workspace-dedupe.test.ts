import { describe, expect, it, vi } from 'vitest'
import type { Project } from '../../../../shared/project-types'
import type {
  HerdrHostTransport,
  HerdrResponse,
  HerdrSessionSnapshot
} from './herdr-runtime-contract'
import { HerdrRuntimeManager } from './herdr-runtime-manager'

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
    tabsByWorktreeId: {
      'worktree-1': [
        {
          id: 'tab-1',
          ptyId: null,
          worktreeId: 'worktree-1',
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    layoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf' as const, leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null
      }
    }
  }
}

function stockTransport() {
  const snapshot: HerdrSessionSnapshot = {
    version: '0.8.0',
    protocol: 19,
    workspaces: [],
    tabs: [],
    panes: [],
    layouts: [],
    agents: []
  }
  const requestMock = vi.fn(
    async (_session: string, method: string, params: unknown): Promise<HerdrResponse<unknown>> => {
      if (method === 'session.snapshot') {
        return { id: 'snapshot', result: { snapshot } }
      }
      if (method === 'workspace.create') {
        const workspace = { workspace_id: 'w1', label: 'repo' }
        const tab = { tab_id: 'w1:t1', workspace_id: 'w1', label: '1' }
        const rootPane = { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }
        return { id: 'workspace', result: { workspace, tab, root_pane: rootPane } }
      }
      if (method === 'workspace.report_metadata') {
        const input = params as { workspace_id: string; tokens: Record<string, string> }
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

describe('Herdr workspace dedupe', () => {
  it('does not create a herdr workspace for a sibling worktree with no orca tabs', async () => {
    const host = stockTransport()
    const persist = vi.fn()
    const present = vi.fn()
    const manager = new HerdrRuntimeManager(host.transport, undefined, undefined, {
      persist,
      present
    })

    await manager.reconcileProjectHost({
      ...singleLeafGraph(),
      worktrees: [
        {
          id: 'worktree-1',
          instanceId: 'instance-1',
          path: '/repo/zsh-patina',
          displayName: 'zsh-patina'
        },
        {
          id: 'worktree-main',
          instanceId: 'instance-main',
          path: '/repo',
          displayName: 'zsh-patina'
        }
      ]
    })

    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'workspace.create')
    ).toHaveLength(1)
    expect(present).not.toHaveBeenCalled()
    expect(host.snapshot.workspaces).toHaveLength(1)
  })

  it('reuses the existing workspace pane instead of layout.apply after bindings are forgotten', async () => {
    const host = stockTransport()
    const manager = new HerdrRuntimeManager(host.transport)
    await manager.reconcileProjectHost(singleLeafGraph())
    const map = (manager as unknown as { paneIdsBySessionAndBinding: Map<string, string> })
      .paneIdsBySessionAndBinding
    map.clear()
    for (const workspace of host.snapshot.workspaces) {
      delete workspace.tokens
    }

    const paneId = await manager.materializeLeafPane(project(), 'existing-leaf', '/repo', {
      id: 'worktree-1',
      path: '/repo',
      displayName: 'repo'
    })

    expect(paneId).toBe('w1:p1')
    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'layout.apply')
    ).toHaveLength(0)
    expect(
      host.requestMock.mock.calls.filter(([, method]) => method === 'workspace.create')
    ).toHaveLength(1)
  })
})
