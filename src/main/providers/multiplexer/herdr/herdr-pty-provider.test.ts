import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { herdrSessionNameForProject } from '../../../../shared/herdr-session-identity'
import type {
  HerdrHostTransport,
  HerdrResponse,
  HerdrTerminalClosed,
  HerdrTerminalController,
  HerdrTerminalFrame
} from './herdr-runtime-contract'
import { decodeHerdrPtyId, HerdrPtyProvider } from './herdr-pty-provider'
import { encodeHerdrPtyId } from './herdr-pty-codec'
import { findLegacyMigrationBlockers } from './herdr-pty-types'
import type { Project } from '../../../../shared/project-types'
import { orcaPaneBinding } from './herdr-binding-metadata'
import type { HerdrProjectHostGraph } from './herdr-runtime-graph'

function transport(closeBeforeFrame = false) {
  const frameListeners = new Set<(frame: HerdrTerminalFrame) => void>()
  const closedListeners = new Set<(event: HerdrTerminalClosed) => void>()
  const controller: HerdrTerminalController = {
    write: vi.fn(),
    resize: vi.fn(),
    release: vi.fn(),
    onFrame: (listener) => {
      frameListeners.add(listener)
      return () => frameListeners.delete(listener)
    },
    onClosed: (listener) => {
      closedListeners.add(listener)
      return () => closedListeners.delete(listener)
    }
  }
  const requestMock = vi.fn(
    async (
      _session: string,
      method: string,
      _params?: unknown
    ): Promise<HerdrResponse<unknown>> => {
      if (method === 'session.snapshot') {
        const bindingToken = orcaPaneBinding('project-1', 'leaf-1')
        return {
          id: 'snapshot',
          result: {
            snapshot: {
              version: '0.7.5',
              protocol: 18,
              workspaces: [
                {
                  workspace_id: 'w1',
                  label: 'repo',
                  tokens: { orca_binding: orcaPaneBinding('project-1', 'leaf-1') },
                  worktree: { checkout_path: '/repo' }
                }
              ],
              tabs: [{ tab_id: 't1', workspace_id: 'w1', label: 'Terminal' }],
              panes: [
                {
                  pane_id: 'p1',
                  tab_id: 't1',
                  workspace_id: 'w1',
                  tokens: { orca_binding: bindingToken }
                }
              ],
              layouts: [],
              agents: []
            }
          }
        }
      }
      if (method === 'workspace.create') {
        return {
          id: 'create',
          result: {
            workspace: { workspace_id: 'w1', label: 'repo' },
            tab: { tab_id: 't1', workspace_id: 'w1', label: 'Terminal' },
            root_pane: { pane_id: 'p1', tab_id: 't1', workspace_id: 'w1' }
          }
        }
      }
      if (method === 'workspace.report_metadata') {
        return { id: 'workspace-metadata', result: { type: 'ok' } }
      }
      if (method === 'pane.report_metadata') {
        return { id: 'pane-metadata', result: { type: 'ok' } }
      }
      if (method === 'pane.read') {
        return {
          id: 'read',
          result: { read: { text: 'history\nprompt$ ', revision: 7 } }
        }
      }
      if (method === 'pane.get') {
        return {
          id: 'pane',
          result: {
            pane: { pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd: '/repo' }
          }
        }
      }
      if (method === 'pane.close' || method === 'pane.send_keys' || method === 'agent.start') {
        return { id: method, result: { type: 'ok' } }
      }
      throw new Error(`unexpected method ${method}`)
    }
  )
  const request: HerdrHostTransport['request'] = async <T>(session, method, params) =>
    (await requestMock(session, method, params)) as HerdrResponse<T>
  const value: HerdrHostTransport = {
    ensureSession: vi.fn(async () => undefined),
    request,
    controlTerminal: vi.fn(() => {
      setTimeout(() => {
        if (closeBeforeFrame) {
          for (const listener of closedListeners) {
            listener({ type: 'terminal.closed', reason: 'closed' })
          }
        } else {
          for (const listener of frameListeners) {
            listener({
              type: 'terminal.frame',
              seq: 1,
              encoding: 'ansi',
              width: 120,
              height: 40,
              full: true,
              bytes: Buffer.from('prompt$ ', 'utf8').toString('base64')
            })
          }
        }
      }, 0)
      return controller
    })
  }
  return { value, requestMock }
}

function target(): {
  project: Project
  graph: HerdrProjectHostGraph
  identity: {
    version: 2
    hostId: string
    projectId: string
    worktreeId: string
    tabId: string
    leafId: string
  }
  activateHerdr?: () => Promise<void>
  legacyMigrationWorktreeIds?: string[]
} {
  return {
    project: {
      id: 'project-1',
      displayName: 'Test Project',
      badgeColor: '#000000',
      sourceRepoIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    },
    graph: {
      project: {
        id: 'project-1',
        displayName: 'Test Project',
        badgeColor: '#000000',
        sourceRepoIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      worktrees: [],
      tabsByWorktreeId: {},
      layoutsByTabId: {}
    },
    identity: {
      version: 2,
      hostId: 'local',
      projectId: 'project-1',
      worktreeId: 'repo-1::/repo',
      tabId: 'tab-1',
      leafId: 'leaf-1'
    } as const,
    legacyMigrationWorktreeIds: ['repo-1::/repo']
  }
}

describe('HerdrPtyProvider', () => {
  it('finds legacy migration blockers', () => {
    const processes = [
      { id: 'terminal-1', worktreeId: 'repo-1::/repo', cwd: '/', title: 'Terminal' },
      { id: 'setup-1', worktreeId: 'repo-1::/repo', cwd: '/', title: 'Setup' },
      { id: 'other-1', worktreeId: 'repo-2::/other', cwd: '/', title: 'Other' }
    ]
    expect(findLegacyMigrationBlockers(processes, ['repo-1::/repo'])).toEqual([
      'terminal-1',
      'setup-1'
    ])
  })

  it('mounts, identifies, reads, and explicitly closes a stock Herdr pane', async () => {
    const host = transport()
    const provider = new HerdrPtyProvider(
      () => host.value,
      async () => target(),
      () => 'test-session'
    )
    const spawned = await provider.spawn({
      cols: 120,
      rows: 40,
      cwd: '/repo',
      worktreeId: 'repo-1::/repo',
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1'
    })

    expect(decodeHerdrPtyId(spawned.id)).toMatchObject({
      version: 2,
      leafId: 'leaf-1',
      paneId: 'p1'
    })
    expect(spawned.snapshot).toBe('prompt$ ')
    expect(await provider.getBufferSnapshot(spawned.id, { scrollbackRows: 500 })).toEqual({
      data: 'history\nprompt$ ',
      cols: 120,
      rows: 40,
      cwd: '/repo',
      seq: 7,
      source: 'headless'
    })
    await provider.shutdown(spawned.id, {})
    expect(host.requestMock).toHaveBeenCalledWith(
      herdrSessionNameForProject({ id: 'project-1' }, 'test-session'),
      'pane.close',
      {
        pane_id: 'p1'
      }
    )
    expect(host.value.controlTerminal).toHaveBeenCalled()
  })

  it('starts a stock Herdr agent instead of writing a shell command', async () => {
    const host = transport()
    const provider = new HerdrPtyProvider(
      () => host.value,
      async () => target(),
      () => 'test-session'
    )
    await provider.spawn({
      cols: 80,
      rows: 24,
      cwd: '/repo',
      worktreeId: 'repo-1::/repo',
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1',
      launchAgent: 'claude',
      command: 'claude'
    })

    expect(host.requestMock).toHaveBeenCalledWith(
      herdrSessionNameForProject({ id: 'project-1' }, 'test-session'),
      'agent.start',
      expect.objectContaining({
        kind: 'claude',
        pane_id: 'p1'
      })
    )
  })

  it('rejects a controller that closes before producing its first frame', async () => {
    const host = transport(true)
    const provider = new HerdrPtyProvider(
      () => host.value,
      async () => target(),
      () => 'test-session'
    )
    await expect(
      provider.spawn({
        cols: 80,
        rows: 24,
        cwd: '/repo',
        worktreeId: 'repo-1::/repo',
        tabId: 'tab-1',
        paneKey: 'tab-1:leaf-1'
      })
    ).rejects.toThrow('closed before its first frame')
  })

  it('signals a stale attach as gone so the owner can retire and fresh-spawn', async () => {
    const host = transport()
    const provider = new HerdrPtyProvider(
      () => host.value,
      async () => target(),
      () => 'test-session'
    )
    const staleSessionId = encodeHerdrPtyId({
      version: 2,
      hostId: 'local',
      projectId: 'project-1',
      worktreeId: 'repo-1::/repo',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      paneId: 'p-stale'
    })
    await expect(
      provider.spawn({
        cols: 80,
        rows: 24,
        cwd: '/repo',
        sessionId: staleSessionId,
        attachOnly: true,
        worktreeId: 'repo-1::/repo',
        tabId: 'tab-1',
        paneKey: 'tab-1:leaf-1'
      })
    ).rejects.toThrow(/Session not found/)
  })
})
