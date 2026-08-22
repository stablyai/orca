import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalWindowTransferHarness,
  FakeWindow,
  ipcEvent,
  terminalWindowSeed,
  terminalWindowSession
} from './terminal-window-transfer-test-fixture'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  },
  screen: {
    getCursorScreenPoint: vi.fn(),
    getDisplayNearestPoint: vi.fn()
  }
}))

vi.mock('./pty', () => ({
  handoffPtyRendererOwnership: vi.fn(),
  registerPtyRenderer: vi.fn(),
  sendToPtyOwner: vi.fn()
}))

vi.mock('../window/createMainWindow', () => ({ loadMainWindow: vi.fn() }))

const concurrentEditor = {
  filePath: '/tmp/repo-1/new.ts',
  relativePath: 'new.ts',
  worktreeId: 'wt-1',
  language: 'typescript'
}

describe('terminal window transfer rollback', () => {
  beforeEach(() => vi.clearAllMocks())

  it('restores only the transferred tab when source removal fails', async () => {
    const h = createTerminalWindowTransferHarness()
    const other = new FakeWindow(4, { x: 1200, y: 0, width: 500, height: 500 })
    h.windows.register(other as never, 'secondary')
    h.owners.registerRenderer(other.webContents as never)
    h.owners.markDispatcherReady(other.webContents as never)
    h.owners.claim('pty-other', other.webContents as never)
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    const coordinator = new TerminalWindowTransferCoordinator({
      store: {} as never,
      createSecondaryWindow: vi.fn(),
      windows: h.windows,
      sessions: h.sessions as never,
      owners: h.owners,
      getCursorPoint: () => ({ x: 700, y: 100 }),
      handoff: h.handoff,
      timeoutMs: 100
    })
    h.target.webContents.send.mockImplementation((_channel, command) => {
      if (command.phase === 'target-import') {
        h.records.set(h.target.id, {
          ...terminalWindowSession(true),
          openFilesByWorktree: { 'wt-1': [concurrentEditor] },
          browserUrlHistory: [
            {
              url: 'https://target.example',
              normalizedUrl: 'https://target.example/',
              title: 'Target',
              lastVisitedAt: 2,
              visitCount: 1
            }
          ]
        })
      }
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
          ...command,
          ok: command.phase === 'target-import'
        })
      )
    })
    h.source.webContents.send.mockImplementation((_channel, command) => {
      if (command.phase === 'source-remove') {
        h.records.set(h.source.id, {
          ...terminalWindowSession(false),
          openFilesByWorktree: { 'wt-1': [concurrentEditor] },
          browserUrlHistory: [
            {
              url: 'https://source.example',
              normalizedUrl: 'https://source.example/',
              title: 'Source',
              lastVisitedAt: 3,
              visitCount: 1
            }
          ]
        })
      }
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.source.webContents) as never, {
          ...command,
          ok: false,
          error: 'source_remove_boom'
        })
      )
    })
    coordinator.getContext(ipcEvent(h.target.webContents) as never)

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, terminalWindowSeed())
    ).resolves.toEqual({ ok: false, error: 'source_remove_boom' })

    const source = h.records.get(h.source.id)!
    const target = h.records.get(h.target.id)!
    expect(source.tabsByWorktree['wt-1']?.map(({ id }) => id)).toContain('tab-1')
    expect(source.terminalLayoutsByTabId['tab-1']).toEqual(terminalWindowSeed().layout)
    expect(source.unifiedTabs?.['wt-1']?.map(({ id }) => id)).toContain('tab-1')
    expect(source.tabGroups?.['wt-1']?.[0]?.tabOrder).toContain('tab-1')
    expect(source.openFilesByWorktree?.['wt-1']).toEqual([concurrentEditor])
    expect(source.browserUrlHistory?.map(({ url }) => url)).toEqual(['https://source.example'])
    expect(target.tabsByWorktree['wt-1'] ?? []).toEqual([])
    expect(target.terminalLayoutsByTabId['tab-1']).toBeUndefined()
    expect(target.openFilesByWorktree?.['wt-1']).toEqual([concurrentEditor])
    expect(target.browserUrlHistory?.map(({ url }) => url)).toEqual(['https://target.example'])
    expect(h.owners.owns('pty-1', h.source.webContents as never)).toBe(true)
    expect(h.owners.owns('pty-other', other.webContents as never)).toBe(true)
  })

  it('commits before revealing a created target and ignores reveal failures', async () => {
    const h = createTerminalWindowTransferHarness({ createTarget: true })
    h.target.visible = false
    const order: string[] = []
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    const createSecondaryWindow = vi.fn(() => {
      order.push('create-hidden')
      expect(h.target.isVisible()).toBe(false)
      h.windows.register(h.target as never, 'secondary')
      return h.target as never
    })
    let coordinator!: InstanceType<typeof TerminalWindowTransferCoordinator>
    coordinator = new TerminalWindowTransferCoordinator({
      store: {} as never,
      createSecondaryWindow,
      windows: h.windows,
      sessions: h.sessions as never,
      owners: h.owners,
      getCursorPoint: () => ({ x: 700, y: 100 }),
      getWorkArea: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
      registerRenderer: vi.fn(() => vi.fn()),
      loadWindow: vi.fn(() => {
        order.push('load-hidden')
        expect(h.target.isVisible()).toBe(false)
        coordinator.getContext(ipcEvent(h.target.webContents) as never)
      }),
      handoff: (ids, from, to) => {
        order.push('handoff-hidden')
        h.handoff(ids, from, to)
      },
      timeoutMs: 100
    })
    h.target.webContents.send.mockImplementation((_channel, command) => {
      order.push(`${command.phase}-hidden`)
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
          ...command,
          ok: true
        })
      )
    })
    h.source.webContents.send.mockImplementation((_channel, command) => {
      order.push(`${command.phase}-hidden`)
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.source.webContents) as never, {
          ...command,
          ok: true,
          empty: false
        })
      )
    })
    h.target.show.mockImplementation(() => {
      order.push('show')
      throw new Error('show_boom')
    })
    h.target.focus.mockImplementation(() => {
      order.push('focus')
      throw new Error('focus_boom')
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, terminalWindowSeed())
    ).resolves.toEqual({ ok: true, targetWindowId: h.target.id })
    expect(order).toEqual([
      'create-hidden',
      'load-hidden',
      'handoff-hidden',
      'target-import-hidden',
      'source-remove-hidden',
      'show',
      'focus'
    ])
    expect(h.owners.owns('pty-1', h.target.webContents as never)).toBe(true)
  })

  it('keeps the transfer error when every later cleanup step throws', async () => {
    const h = createTerminalWindowTransferHarness({ createTarget: true })
    h.target.visible = false
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    const originalSet = h.sessions.set.getMockImplementation()!
    let setCount = 0
    h.sessions.set.mockImplementation((...args) => {
      if (++setCount > 1) {
        throw new Error('session_cleanup_boom')
      }
      return originalSet(...args)
    })
    h.target.destroy.mockImplementation(() => {
      throw new Error('destroy_cleanup_boom')
    })
    let coordinator!: InstanceType<typeof TerminalWindowTransferCoordinator>
    coordinator = new TerminalWindowTransferCoordinator({
      store: {} as never,
      createSecondaryWindow: () => {
        h.windows.register(h.target as never, 'secondary')
        return h.target as never
      },
      windows: h.windows,
      sessions: h.sessions as never,
      owners: h.owners,
      getCursorPoint: () => ({ x: 700, y: 100 }),
      getWorkArea: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
      registerRenderer: vi.fn(() => () => {
        throw new Error('dispose_cleanup_boom')
      }),
      loadWindow: () => coordinator.getContext(ipcEvent(h.target.webContents) as never),
      handoff: h.handoff,
      timeoutMs: 100
    })
    h.target.webContents.send.mockImplementation((_channel, command) => {
      if (command.phase === 'target-remove') {
        throw new Error('command_cleanup_boom')
      }
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
          ...command,
          ok: false,
          error: 'primary_transfer_error'
        })
      )
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, terminalWindowSeed())
    ).resolves.toEqual({ ok: false, error: 'primary_transfer_error' })
    expect(h.owners.owns('pty-1', h.source.webContents as never)).toBe(true)
  })

  it('rolls back a timed out target import with the same transfer id', async () => {
    const h = createTerminalWindowTransferHarness()
    const commands: { phase: string; transferId: string }[] = []
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    const coordinator = new TerminalWindowTransferCoordinator({
      store: {} as never,
      createSecondaryWindow: vi.fn(),
      windows: h.windows,
      sessions: h.sessions as never,
      owners: h.owners,
      getCursorPoint: () => ({ x: 700, y: 100 }),
      handoff: h.handoff,
      timeoutMs: 5
    })
    h.target.webContents.send.mockImplementation((_channel, command) => {
      commands.push(command)
      if (command.phase === 'target-remove') {
        queueMicrotask(() =>
          coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
            ...command,
            ok: true
          })
        )
      }
    })
    coordinator.getContext(ipcEvent(h.target.webContents) as never)

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, terminalWindowSeed())
    ).resolves.toEqual({ ok: false, error: 'terminal_transfer_target-import_timeout' })
    expect(commands.map(({ phase }) => phase)).toEqual(['target-import', 'target-remove'])
    expect(commands[1]?.transferId).toBe(commands[0]?.transferId)
    expect(h.owners.owns('pty-1', h.source.webContents as never)).toBe(true)
  })

  it('rolls back a timed out source removal with the same transfer id', async () => {
    const h = createTerminalWindowTransferHarness()
    const sourceCommands: { phase: string; transferId: string }[] = []
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    const coordinator = new TerminalWindowTransferCoordinator({
      store: {} as never,
      createSecondaryWindow: vi.fn(),
      windows: h.windows,
      sessions: h.sessions as never,
      owners: h.owners,
      getCursorPoint: () => ({ x: 700, y: 100 }),
      handoff: h.handoff,
      timeoutMs: 5
    })
    h.target.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
          ...command,
          ok: true
        })
      )
    })
    h.source.webContents.send.mockImplementation((_channel, command) => {
      sourceCommands.push(command)
      if (command.phase === 'source-restore') {
        queueMicrotask(() =>
          coordinator.acknowledge(ipcEvent(h.source.webContents) as never, {
            ...command,
            ok: true
          })
        )
      }
    })
    coordinator.getContext(ipcEvent(h.target.webContents) as never)

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, terminalWindowSeed())
    ).resolves.toEqual({ ok: false, error: 'terminal_transfer_source-remove_timeout' })
    expect(sourceCommands.map(({ phase }) => phase)).toEqual(['source-remove', 'source-restore'])
    expect(sourceCommands[1]?.transferId).toBe(sourceCommands[0]?.transferId)
    expect(h.owners.owns('pty-1', h.source.webContents as never)).toBe(true)
  })
})
