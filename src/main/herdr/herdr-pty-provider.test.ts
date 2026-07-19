import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../providers/types'
import type {
  HerdrHostTransport,
  HerdrResponse,
  HerdrTerminalClosed,
  HerdrTerminalController,
  HerdrTerminalFrame
} from './herdr-runtime-contract'
import {
  decodeHerdrPtyId,
  findLegacyMigrationBlockers,
  HerdrPtyProvider
} from './herdr-pty-provider'

function fallback(): IPtyProvider {
  const empty = () => () => undefined
  return {
    spawn: vi.fn(async () => ({ id: 'fallback' })),
    attach: vi.fn(async () => undefined),
    write: vi.fn(),
    resize: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    sendSignal: vi.fn(async () => undefined),
    getCwd: vi.fn(async () => '/fallback'),
    getInitialCwd: vi.fn(async () => '/fallback'),
    clearBuffer: vi.fn(async () => undefined),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(async () => false),
    getForegroundProcess: vi.fn(async () => null),
    serialize: vi.fn(async () => ''),
    revive: vi.fn(async () => undefined),
    listProcesses: vi.fn(async () => []),
    getDefaultShell: vi.fn(async () => '/bin/zsh'),
    getProfiles: vi.fn(async () => []),
    onData: empty,
    onReplay: empty,
    onExit: empty
  }
}

function transport() {
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
  let created = false
  const requestMock = vi.fn(async (_session: string, method: string, _params?: unknown) => {
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
            graph_revision: created ? 1 : 0,
            workspaces: created
              ? [
                  {
                    workspace_id: 'w1',
                    external_ref: { owner: 'orca', id: 'project-1:worktree:instance-1' }
                  }
                ]
              : [],
            tabs: created
              ? [
                  {
                    tab_id: 't1',
                    workspace_id: 'w1',
                    external_ref: { owner: 'orca', id: 'project-1:tab:tab-1' }
                  }
                ]
              : [],
            panes: created
              ? [
                  {
                    pane_id: 'p1',
                    tab_id: 't1',
                    workspace_id: 'w1',
                    external_ref: { owner: 'orca', id: 'project-1:pane:leaf-1' }
                  }
                ]
              : []
          }
        }
      } as HerdrResponse<unknown>
    }
    if (method === 'workspace.create') {
      created = true
      return {
        id: 'create',
        result: {
          workspace: {
            workspace_id: 'w1',
            external_ref: { owner: 'orca', id: 'project-1:worktree:instance-1' }
          },
          tab: {
            tab_id: 't1',
            workspace_id: 'w1',
            external_ref: { owner: 'orca', id: 'project-1:tab:tab-1' }
          },
          root_pane: {
            pane_id: 'p1',
            tab_id: 't1',
            workspace_id: 'w1',
            external_ref: { owner: 'orca', id: 'project-1:pane:leaf-1' }
          }
        }
      } as HerdrResponse<unknown>
    }
    if (method === 'pane.close') {
      return { id: 'close', result: {} } as HerdrResponse<unknown>
    }
    if (method === 'pane.send_keys') {
      return { id: 'keys', result: {} } as HerdrResponse<unknown>
    }
    if (method === 'pane.read') {
      return {
        id: 'read',
        result: { read: { text: 'history\nprompt$ ', revision: 7, truncated: false } }
      } as HerdrResponse<unknown>
    }
    if (method === 'pane.get') {
      return {
        id: 'pane',
        result: { pane: { pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd: '/repo' } }
      } as HerdrResponse<unknown>
    }
    throw new Error(`unexpected method ${method}`)
  })
  const request: HerdrHostTransport['request'] = async <T>(session, method, params) =>
    (await requestMock(session, method, params)) as HerdrResponse<T>
  const value: HerdrHostTransport = {
    ensureSession: vi.fn(async () => undefined),
    request,
    controlTerminal: vi.fn(() => {
      setTimeout(() => {
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
      }, 0)
      return controller
    })
  }
  return { value, controller, request: requestMock }
}

describe('HerdrPtyProvider', () => {
  it('reports every live legacy PTY in the project worktrees as a migration blocker', () => {
    expect(
      findLegacyMigrationBlockers(
        [
          { id: 'terminal-1', worktreeId: 'worktree-1' },
          { id: 'setup-1', worktreeId: 'worktree-1' },
          { id: 'other-project', worktreeId: 'worktree-2' }
        ] as never,
        ['worktree-1']
      )
    ).toEqual(['terminal-1', 'setup-1'])
  })

  it('mounts a reconciled pane, returns its full frame, and closes it explicitly', async () => {
    const host = transport()
    const legacy = fallback()
    const activateHerdr = vi.fn()
    const provider = new HerdrPtyProvider(legacy, host.value, async () => ({
      activateHerdr,
      project: {
        id: 'project-1',
        displayName: 'Project',
        badgeColor: '#000',
        sourceRepoIds: ['repo-1'],
        createdAt: 1,
        updatedAt: 1
      },
      identity: {
        hostId: 'local',
        projectId: 'project-1',
        worktreeId: 'repo-1::/repo',
        tabId: 'tab-1',
        leafId: 'leaf-1'
      },
      graph: {
        project: {
          id: 'project-1',
          displayName: 'Project',
          badgeColor: '#000',
          sourceRepoIds: ['repo-1'],
          createdAt: 1,
          updatedAt: 1
        },
        worktrees: [
          { id: 'repo-1::/repo', instanceId: 'instance-1', path: '/repo', displayName: 'repo' }
        ],
        tabsByWorktreeId: {
          'repo-1::/repo': [
            {
              id: 'tab-1',
              ptyId: null,
              worktreeId: 'repo-1::/repo',
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
            root: { type: 'leaf', leafId: 'leaf-1' },
            activeLeafId: 'leaf-1',
            expandedLeafId: null
          }
        }
      }
    }))

    const spawned = await provider.spawn({
      cols: 120,
      rows: 40,
      cwd: '/repo',
      worktreeId: 'repo-1::/repo',
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1'
    })
    expect(decodeHerdrPtyId(spawned.id)).toMatchObject({ leafId: 'leaf-1' })
    expect(activateHerdr).toHaveBeenCalledOnce()
    expect(spawned.snapshot).toBe('prompt$ ')

    provider.write(spawned.id, 'echo hi\r')
    provider.resize(spawned.id, 90, 30)
    expect(host.controller.write).toHaveBeenCalledWith('echo hi\r')
    expect(host.controller.resize).toHaveBeenCalledWith(90, 30)
    expect(provider.canProvideAuthoritativeBufferSnapshot(spawned.id)).toBe(true)
    expect(await provider.getBufferSnapshot(spawned.id, { scrollbackRows: 500 })).toEqual({
      data: 'history\nprompt$ ',
      cols: 90,
      rows: 30,
      cwd: '/repo',
      seq: 7,
      source: 'headless'
    })
    await provider.clearBuffer(spawned.id)
    expect(host.request).toHaveBeenCalledWith('orca-project-1', 'pane.send_keys', {
      pane_id: 'p1',
      keys: ['ctrl+l']
    })

    const replacementLegacy = fallback()
    provider.replaceFallback(replacementLegacy)
    provider.write('legacy-pty', 'legacy input')
    expect(replacementLegacy.write).toHaveBeenCalledWith('legacy-pty', 'legacy input')
    expect(provider.hasPty(spawned.id)).toBe(true)

    await provider.shutdown(spawned.id, {})
    expect(host.request).toHaveBeenCalledWith('orca-project-1', 'pane.close', { pane_id: 'p1' })
    expect(host.controller.release).toHaveBeenCalled()
    expect(legacy.shutdown).not.toHaveBeenCalled()
  })

  it('rejects a controller that closes before producing its first frame', async () => {
    const host = transport()
    vi.mocked(host.value.controlTerminal!).mockImplementationOnce(() => {
      const controller = host.controller
      return {
        ...controller,
        onClosed: (listener) => {
          setTimeout(() => listener({ type: 'terminal.closed', reason: 'connection failed' }), 0)
          return () => undefined
        }
      }
    })
    const provider = new HerdrPtyProvider(fallback(), host.value, async () => ({
      project: {
        id: 'project-1',
        displayName: 'Project',
        badgeColor: '#000',
        sourceRepoIds: ['repo-1'],
        createdAt: 1,
        updatedAt: 1
      },
      identity: {
        hostId: 'local',
        projectId: 'project-1',
        worktreeId: 'repo-1::/repo',
        tabId: 'tab-1',
        leafId: 'leaf-1'
      },
      graph: {
        project: {
          id: 'project-1',
          displayName: 'Project',
          badgeColor: '#000',
          sourceRepoIds: ['repo-1'],
          createdAt: 1,
          updatedAt: 1
        },
        worktrees: [
          { id: 'repo-1::/repo', instanceId: 'instance-1', path: '/repo', displayName: 'repo' }
        ],
        tabsByWorktreeId: {
          'repo-1::/repo': [
            {
              id: 'tab-1',
              ptyId: null,
              worktreeId: 'repo-1::/repo',
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
            root: { type: 'leaf', leafId: 'leaf-1' },
            activeLeafId: 'leaf-1',
            expandedLeafId: null
          }
        }
      }
    }))

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
})
