import { describe, expect, it, vi } from 'vitest'
import type { Project, TerminalTab, Worktree } from '../../shared/types'
import type {
  HerdrHostTransport,
  HerdrResponse,
  HerdrTerminalController
} from './herdr-runtime-contract'
import { HerdrRuntimeManager } from './herdr-runtime-manager'

function project(): Project {
  return {
    id: 'project-1',
    displayName: 'Project',
    badgeColor: '#000000',
    sourceRepoIds: ['repo-1'],
    createdAt: 1,
    updatedAt: 1
  }
}

function worktree(): Worktree {
  return {
    id: 'repo-1::/repo',
    instanceId: 'worktree-instance-1',
    repoId: 'repo-1',
    projectId: 'project-1',
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    path: '/repo',
    branch: 'main',
    head: 'abc123',
    isBare: false,
    isMainWorktree: true
  }
}

function tab(): TerminalTab {
  return {
    id: 'terminal-tab-1',
    ptyId: null,
    worktreeId: 'repo-1::/repo',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('HerdrRuntimeManager', () => {
  it('maps project, worktree, tab, and pane identities and translates split directions', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = []
    let snapshotCalls = 0
    const request = async <T>(
      _session: string,
      method: string,
      params: unknown
    ): Promise<HerdrResponse<T>> => {
      calls.push({ method, params: params as Record<string, unknown> })
      if (method === 'session.snapshot') {
        snapshotCalls += 1
        const reconciled = snapshotCalls > 1
        return {
          id: 'snapshot',
          result: {
            snapshot: {
              protocol: 17,
              capabilities: {
                external_refs: true,
                resumable_events: true,
                portable_layouts: true,
                terminal_control_v2: true,
                terminal_history: true,
                controller_takeover: true,
                pane_restart: false
              },
              graph_revision: snapshotCalls,
              workspaces: reconciled
                ? [
                    {
                      workspace_id: 'w1',
                      external_ref: {
                        owner: 'orca',
                        id: 'project-1:worktree:worktree-instance-1'
                      }
                    }
                  ]
                : [],
              tabs: reconciled
                ? [
                    {
                      tab_id: 'w1:t1',
                      workspace_id: 'w1',
                      external_ref: { owner: 'orca', id: 'project-1:tab:terminal-tab-1' }
                    }
                  ]
                : [],
              panes: reconciled
                ? [
                    {
                      pane_id: 'w1:p1',
                      tab_id: 'w1:t1',
                      workspace_id: 'w1',
                      external_ref: { owner: 'orca', id: 'project-1:pane:leaf-a' }
                    },
                    {
                      pane_id: 'w1:p2',
                      tab_id: 'w1:t1',
                      workspace_id: 'w1',
                      external_ref: { owner: 'orca', id: 'project-1:pane:leaf-b' }
                    }
                  ]
                : []
            }
          }
        } as HerdrResponse<T>
      }
      if (method === 'workspace.create') {
        const request = params as Record<string, { owner: 'orca'; id: string }>
        return {
          id: 'workspace',
          result: {
            workspace: { workspace_id: 'w1', external_ref: request.external_ref },
            tab: {
              tab_id: 'w1:t1',
              workspace_id: 'w1',
              external_ref: request.root_tab_external_ref
            },
            root_pane: {
              pane_id: 'w1:p1',
              tab_id: 'w1:t1',
              workspace_id: 'w1',
              external_ref: request.root_pane_external_ref
            }
          }
        } as HerdrResponse<T>
      }
      if (method === 'tab.bind') {
        const request = params as { external_ref: { owner: string; id: string } }
        return {
          id: 'tab',
          result: {
            tab: { tab_id: 'w1:t1', workspace_id: 'w1', external_ref: request.external_ref }
          }
        } as HerdrResponse<T>
      }
      if (method === 'pane.bind') {
        const request = params as { external_ref: { owner: string; id: string } }
        return {
          id: 'pane',
          result: {
            pane: {
              pane_id: 'w1:p1',
              tab_id: 'w1:t1',
              workspace_id: 'w1',
              external_ref: request.external_ref
            }
          }
        } as HerdrResponse<T>
      }
      if (method === 'pane.split') {
        const request = params as Record<string, { owner: 'orca'; id: string }>
        return {
          id: 'pane',
          result: {
            pane: {
              pane_id: 'w1:p2',
              tab_id: 'w1:t1',
              workspace_id: 'w1',
              external_ref: request.external_ref
            }
          }
        } as HerdrResponse<T>
      }
      throw new Error(`unexpected method ${method}`)
    }
    const controller: HerdrTerminalController = {
      write: vi.fn(),
      resize: vi.fn(),
      release: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClosed: vi.fn(() => () => undefined)
    }
    const controlTerminal = vi.fn(() => controller)
    const transport: HerdrHostTransport = {
      ensureSession: vi.fn(async () => undefined),
      request,
      controlTerminal
    }

    const manager = new HerdrRuntimeManager(transport)
    await manager.reconcileProjectHost({
      project: project(),
      worktrees: [worktree()],
      tabsByWorktreeId: { [worktree().id]: [tab()] },
      layoutsByTabId: {
        [tab().id]: {
          root: {
            type: 'split',
            direction: 'vertical',
            ratio: 0.4,
            first: { type: 'leaf', leafId: 'leaf-a' },
            second: { type: 'leaf', leafId: 'leaf-b' }
          },
          activeLeafId: 'leaf-a',
          expandedLeafId: null
        }
      }
    })

    expect(transport.ensureSession).toHaveBeenCalledWith('orca-project-1')
    expect(calls.find((call) => call.method === 'workspace.create')?.params).toMatchObject({
      external_ref: { owner: 'orca', id: 'project-1:worktree:worktree-instance-1' },
      root_tab_external_ref: { owner: 'orca', id: 'project-1:tab:terminal-tab-1' },
      root_pane_external_ref: { owner: 'orca', id: 'project-1:pane:leaf-a' }
    })
    expect(calls.find((call) => call.method === 'pane.split')?.params).toMatchObject({
      target_pane_id: 'w1:p1',
      direction: 'right',
      ratio: 0.4,
      external_ref: { owner: 'orca', id: 'project-1:pane:leaf-b' }
    })
    await expect(
      manager.controlProjectPane(project(), 'leaf-b', { cols: 120, rows: 40, takeover: true })
    ).resolves.toBe(controller)
    expect(controlTerminal).toHaveBeenCalledWith('orca-project-1', 'w1:p2', {
      cols: 120,
      rows: 40,
      takeover: true
    })
  })

  it('adopts a uniquely matching unclaimed Herdr hierarchy', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const request = async <T>(
      _session: string,
      method: string,
      params: unknown
    ): Promise<HerdrResponse<T>> => {
      const requestParams = params as Record<string, unknown>
      calls.push({ method, params: requestParams })
      if (method === 'session.snapshot') {
        return {
          id: 'snapshot',
          result: {
            snapshot: {
              protocol: 17,
              capabilities: {
                external_refs: true,
                resumable_events: true,
                portable_layouts: true,
                terminal_control_v2: true,
                terminal_history: true,
                controller_takeover: true,
                pane_restart: false
              },
              graph_revision: 1,
              workspaces: [
                {
                  workspace_id: 'w-existing',
                  label: 'main',
                  worktree: { checkout_path: '/repo' }
                }
              ],
              tabs: [{ tab_id: 't-existing', workspace_id: 'w-existing', label: 'Terminal 1' }],
              panes: [
                {
                  pane_id: 'p-existing',
                  tab_id: 't-existing',
                  workspace_id: 'w-existing'
                }
              ]
            }
          }
        } as HerdrResponse<T>
      }
      if (method === 'workspace.bind') {
        return {
          id: 'workspace',
          result: {
            workspace: {
              workspace_id: 'w-existing',
              worktree: { checkout_path: '/repo' },
              external_ref: requestParams.external_ref
            }
          }
        } as HerdrResponse<T>
      }
      if (method === 'tab.bind') {
        return {
          id: 'tab',
          result: {
            tab: {
              tab_id: 't-existing',
              workspace_id: 'w-existing',
              label: 'Terminal 1',
              external_ref: requestParams.external_ref
            }
          }
        } as HerdrResponse<T>
      }
      if (method === 'pane.bind') {
        return {
          id: 'pane',
          result: {
            pane: {
              pane_id: 'p-existing',
              tab_id: 't-existing',
              workspace_id: 'w-existing',
              external_ref: requestParams.external_ref
            }
          }
        } as HerdrResponse<T>
      }
      throw new Error(`unexpected method ${method}`)
    }
    const manager = new HerdrRuntimeManager({
      ensureSession: vi.fn(async () => undefined),
      request
    })

    await manager.reconcileProjectHost({
      project: project(),
      worktrees: [worktree()],
      tabsByWorktreeId: { [worktree().id]: [tab()] },
      layoutsByTabId: {
        [tab().id]: {
          root: { type: 'leaf', leafId: 'leaf-a' },
          activeLeafId: 'leaf-a',
          expandedLeafId: null
        }
      }
    })

    expect(calls.map((call) => call.method)).toEqual([
      'session.snapshot',
      'workspace.bind',
      'tab.bind',
      'pane.bind',
      'session.snapshot'
    ])
    expect(calls.some((call) => call.method.endsWith('.create'))).toBe(false)
  })
})
