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
import { encodeHerdrPtyId } from './herdr-pty-types'
import { findLegacyMigrationBlockers } from './herdr-pty-types'
import type { Project } from '../../../../shared/project-types'
import { orcaPaneBinding } from './herdr-binding-metadata'
import type { HerdrProjectHostGraph } from './ensure-herdr-workspace'

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
      if (method === 'pane.list') {
        return {
          id: 'list',
          result: { panes: [{ pane_id: 'p1', tab_id: 't1', workspace_id: 'w1' }] }
        }
      }
      if (
        method === 'pane.close' ||
        method === 'workspace.close' ||
        method === 'pane.send_keys' ||
        method === 'pane.send_text' ||
        method === 'agent.start'
      ) {
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
    controlTerminal: vi.fn(
      (
        _session: string,
        _target: string,
        options?: { cols: number; rows: number; observe?: boolean }
      ) => {
        if (options?.observe === true) {
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
        }
        const pulseFrameListeners = new Set<(frame: HerdrTerminalFrame) => void>()
        const pulse: HerdrTerminalController = {
          write: vi.fn(),
          resize: vi.fn(),
          release: vi.fn(),
          onFrame: (listener) => {
            pulseFrameListeners.add(listener)
            return () => pulseFrameListeners.delete(listener)
          },
          onClosed: () => () => undefined
        }
        setTimeout(() => {
          for (const listener of pulseFrameListeners) {
            listener({
              type: 'terminal.frame',
              seq: 1,
              encoding: 'ansi',
              width: options?.cols ?? 80,
              height: options?.rows ?? 24,
              full: true,
              bytes: ''
            })
          }
        }, 0)
        return pulse
      }
    )
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
      'workspace.close',
      { workspace_id: 'w1' }
    )
    expect(host.value.controlTerminal).toHaveBeenCalledWith(
      herdrSessionNameForProject({ id: 'project-1' }, 'test-session'),
      'p1',
      { cols: 120, rows: 40, observe: true }
    )
  })

  it('reports live bindings to the acknowledged write path', async () => {
    const host = transport()
    const provider = new HerdrPtyProvider(
      () => host.value,
      async () => target(),
      () => 'test-session'
    )
    const spawned = await provider.spawn({
      cols: 80,
      rows: 24,
      cwd: '/repo',
      worktreeId: 'repo-1::/repo',
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1'
    })
    expect(provider.hasPty(spawned.id)).toBe(true)
    expect(provider.hasPty('missing')).toBe(false)
    await provider.shutdown(spawned.id, {})
    expect(provider.hasPty(spawned.id)).toBe(false)
  })

  it('writes live keys through pane.send_text and interrupts through pane.send_keys', async () => {
    const host = transport()
    const provider = new HerdrPtyProvider(
      () => host.value,
      async () => target(),
      () => 'test-session'
    )
    const spawned = await provider.spawn({
      cols: 80,
      rows: 24,
      cwd: '/repo',
      worktreeId: 'repo-1::/repo',
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1'
    })
    const controller = host.value.controlTerminal as unknown as ReturnType<typeof vi.fn>
    const spawnedController = controller.mock.results[0]?.value as
      | HerdrTerminalController
      | undefined
    if (!spawnedController) {
      throw new Error('expected a stock Herdr terminal controller')
    }
    const write = spawnedController.write as ReturnType<typeof vi.fn>
    write.mockClear()
    host.requestMock.mockClear()

    provider.write(spawned.id, 'hello')
    provider.write(spawned.id, '\r')
    provider.write(spawned.id, '\x7f')
    provider.write(spawned.id, '\x1b')
    provider.write(spawned.id, '\x01')
    provider.write(spawned.id, '\x1b[A')
    provider.writeLogical(spawned.id, { kind: 'key', name: 'ctrl+c' })
    provider.write(spawned.id, '\x03')
    await vi.waitFor(() => {
      expect(
        host.requestMock.mock.calls.filter((call) => call[1] === 'pane.send_keys')
      ).toHaveLength(2)
    })
    await vi.waitFor(() => {
      expect(
        host.requestMock.mock.calls.filter((call) => call[1] === 'pane.send_text')
      ).toHaveLength(6)
    })

    expect(write).not.toHaveBeenCalled()
    const sendText = host.requestMock.mock.calls.filter((call) => call[1] === 'pane.send_text')
    expect(sendText.map((call) => (call[2] as { text: string }).text)).toEqual([
      'hello',
      '\r',
      '\x7f',
      '\x1b',
      '\x01',
      '\x1b[A'
    ])
    const sendKeys = host.requestMock.mock.calls.filter((call) => call[1] === 'pane.send_keys')
    expect(sendKeys.map((call) => (call[2] as { keys: string[] }).keys)).toEqual([
      ['ctrl+c'],
      ['ctrl+c']
    ])
    expect(sendKeys.every((call) => (call[2] as { pane_id: string }).pane_id === 'p1')).toBe(true)
  })

  it('reads cwd from pane.get with the Herdr pane id', async () => {
    const host = transport()
    const provider = new HerdrPtyProvider(
      () => host.value,
      async () => target(),
      () => 'test-session'
    )
    const spawned = await provider.spawn({
      cols: 80,
      rows: 24,
      cwd: '/repo',
      worktreeId: 'repo-1::/repo',
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1'
    })
    host.requestMock.mockClear()
    await expect(provider.getCwd(spawned.id)).resolves.toBe('/repo')
    expect(host.requestMock).toHaveBeenCalledWith(
      herdrSessionNameForProject({ id: 'project-1' }, 'test-session'),
      'pane.get',
      { pane_id: 'p1' }
    )
    expect(
      host.requestMock.mock.calls.some((call) => {
        const params = call[2] as { pane_id?: string } | undefined
        return params?.pane_id === spawned.id
      })
    ).toBe(false)
  })

  it('returns the last applied size from the binding', async () => {
    const host = transport()
    const provider = new HerdrPtyProvider(
      () => host.value,
      async () => target(),
      () => 'test-session'
    )
    const spawned = await provider.spawn({
      cols: 80,
      rows: 24,
      cwd: '/repo',
      worktreeId: 'repo-1::/repo',
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1'
    })
    await expect(provider.getAppliedSize(spawned.id)).resolves.toEqual({ cols: 120, rows: 40 })
    provider.resize(spawned.id, 100, 30)
    await expect(provider.getAppliedSize(spawned.id)).resolves.toEqual({ cols: 100, rows: 30 })
    const controlTerminal = host.value.controlTerminal as unknown as ReturnType<typeof vi.fn>
    const spawnedController = controlTerminal.mock.results[0]?.value as
      | HerdrTerminalController
      | undefined
    expect(spawnedController?.resize).toHaveBeenCalledWith(100, 30)
    await vi.waitFor(() => {
      expect(
        controlTerminal.mock.calls.some(
          (call) =>
            (call[2] as { cols?: number; observe?: boolean } | undefined)?.cols === 100 &&
            (call[2] as { observe?: boolean } | undefined)?.observe !== true
        )
      ).toBe(true)
    })
  })

  it('clears the local snapshot without sending keys', async () => {
    const host = transport()
    const provider = new HerdrPtyProvider(
      () => host.value,
      async () => target(),
      () => 'test-session'
    )
    const spawned = await provider.spawn({
      cols: 80,
      rows: 24,
      cwd: '/repo',
      worktreeId: 'repo-1::/repo',
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1'
    })
    host.requestMock.mockClear()
    await provider.clearBuffer(spawned.id)
    expect(host.requestMock).not.toHaveBeenCalled()
  })

  it('sends SIGINT to the Herdr pane id, not the Orca pty id', async () => {
    const host = transport()
    const provider = new HerdrPtyProvider(
      () => host.value,
      async () => target(),
      () => 'test-session'
    )
    const spawned = await provider.spawn({
      cols: 80,
      rows: 24,
      cwd: '/repo',
      worktreeId: 'repo-1::/repo',
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1'
    })
    host.requestMock.mockClear()
    const controller = host.value.controlTerminal as unknown as ReturnType<typeof vi.fn>
    const spawnedController = controller.mock.results[0]?.value as
      | HerdrTerminalController
      | undefined
    if (!spawnedController) {
      throw new Error('expected a stock Herdr terminal controller')
    }
    const write = spawnedController.write as ReturnType<typeof vi.fn>
    write.mockClear()
    await provider.sendSignal(spawned.id, 'SIGINT')

    expect(host.requestMock).toHaveBeenCalledWith(
      herdrSessionNameForProject({ id: 'project-1' }, 'test-session'),
      'pane.send_keys',
      { pane_id: 'p1', keys: ['ctrl+c'] }
    )
    expect(write).not.toHaveBeenCalled()
    expect(
      host.requestMock.mock.calls.some((call) => {
        const params = call[2] as { pane_id?: string } | undefined
        return params?.pane_id === spawned.id
      })
    ).toBe(false)
  })

  it('writes a shell command through pane.send_text when no agent is launched', async () => {
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
      command: 'ls'
    })
    await vi.waitFor(() => {
      expect(host.requestMock).toHaveBeenCalledWith(
        herdrSessionNameForProject({ id: 'project-1' }, 'test-session'),
        'pane.send_text',
        { pane_id: 'p1', text: 'ls\r' }
      )
    })
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
    ).rejects.toThrow(/closed/)
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

  it('delegates a non-Herdr spawn to the Orca fallback', async () => {
    const fallback = {
      spawn: vi.fn(async () => ({ id: 'pty-orca' })),
      attach: vi.fn(),
      shutdown: vi.fn(),
      hasPty: vi.fn(() => false),
      write: vi.fn(),
      resize: vi.fn(),
      listProcesses: vi.fn(async () => [{ id: 'pty-orca', cwd: '/', title: 'sh' }]),
      onData: vi.fn(() => () => undefined),
      onExit: vi.fn(() => () => undefined),
      onReplay: vi.fn(() => () => undefined)
    }
    const provider = new HerdrPtyProvider(
      () => transport().value,
      async () => null,
      () => 'test-session',
      undefined,
      fallback as never
    )
    await expect(
      provider.spawn({ cols: 80, rows: 24, cwd: '/repo', worktreeId: 'repo-1::/repo' })
    ).resolves.toEqual({ id: 'pty-orca' })
    expect(fallback.spawn).toHaveBeenCalled()
  })

  it('keeps the binding and rejects when Herdr close fails', async () => {
    const host = transport()
    const provider = new HerdrPtyProvider(
      () => host.value,
      async () => target(),
      () => 'test-session'
    )
    const spawned = await provider.spawn({
      cols: 80,
      rows: 24,
      cwd: '/repo',
      worktreeId: 'repo-1::/repo',
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1'
    })
    host.requestMock.mockImplementation(async (_session: string, method: string) => {
      if (method === 'workspace.close' || method === 'pane.close') {
        return { id: method, error: { code: 'busy', message: 'still attached' } }
      }
      if (method === 'pane.get') {
        return {
          id: method,
          result: { pane: { pane_id: 'p1', workspace_id: 'w1' } }
        }
      }
      if (method === 'pane.list') {
        return { id: method, result: { panes: [{ pane_id: 'p1' }] } }
      }
      return { id: method, result: { type: 'ok' } }
    })
    await expect(provider.shutdown(spawned.id, {})).rejects.toThrow('still attached')
    expect(provider.hasPty(spawned.id)).toBe(true)
  })
})
