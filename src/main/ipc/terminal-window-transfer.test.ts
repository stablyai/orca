import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getTerminalWindowBounds,
  sessionMatchesTerminalWindowTarget
} from './terminal-window-transfer-operation'
import {
  createTerminalWindowTransferHarness as createHarness,
  FakeWindow,
  ipcEvent,
  terminalWindowSeed as seed,
  terminalWindowSession as session
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

describe('TerminalWindowTransferCoordinator', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reopens the transfer gate when a renderer aborts app quit', async () => {
    const h = createHarness()
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    const coordinator = new TerminalWindowTransferCoordinator({
      store: {} as never,
      createSecondaryWindow: vi.fn(),
      windows: h.windows,
      sessions: h.sessions as never,
      owners: h.owners,
      timeoutMs: 10
    })

    await coordinator.fenceForQuit()
    expect(coordinator.getContext(ipcEvent(h.source.webContents) as never).transitionFenced).toBe(
      true
    )
    coordinator.resumeAfterQuitAbort()
    expect(coordinator.getContext(ipcEvent(h.source.webContents) as never).transitionFenced).toBe(
      false
    )
  })

  it('fences new work, settles an active transfer, and removes loss listeners', async () => {
    const h = createHarness()
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

    const transfer = coordinator.detach(ipcEvent(h.source.webContents) as never, seed())
    await coordinator.fenceForQuit()

    await expect(transfer).resolves.toEqual({ ok: false, error: 'terminal_transfer_quit' })
    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, seed())
    ).resolves.toEqual({ ok: false, error: 'window_transfer_fenced' })
    expect(h.source.listenerCount('close')).toBe(0)
    expect(h.target.listenerCount('close')).toBe(0)
    expect(h.source.webContents.listenerCount('render-process-gone')).toBe(0)
    expect(h.target.webContents.listenerCount('render-process-gone')).toBe(0)
  })

  it('matches legacy local target identity without weakening explicit host checks', () => {
    const target = {
      ...session(false),
      activeWorkspaceKey: null,
      activeWorkspaceExecutionHostId: null
    }
    expect(sessionMatchesTerminalWindowTarget(target, seed())).toBe(true)
    expect(sessionMatchesTerminalWindowTarget(target, { ...seed(), hostId: 'runtime:vm-1' })).toBe(
      false
    )
  })

  it('uses integer bounds inside a small odd-sized work area', () => {
    const bounds = getTerminalWindowBounds(
      { x: 155, y: 99 },
      { x: 5, y: 7, width: 301, height: 199 }
    )
    expect(bounds).toEqual({ x: 5, y: 7, width: 301, height: 199 })
    expect(Object.values(bounds).every(Number.isInteger)).toBe(true)
  })

  it('prepares the target record before handing off and commits both renderer commands', async () => {
    const h = createHarness()
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    let coordinator!: InstanceType<typeof TerminalWindowTransferCoordinator>
    coordinator = new TerminalWindowTransferCoordinator({
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
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
          ...command,
          ok: true
        })
      )
    })
    h.source.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.source.webContents) as never, {
          ...command,
          ok: true
        })
      )
    })
    coordinator.getContext(ipcEvent(h.target.webContents) as never)

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, seed())
    ).resolves.toEqual({
      ok: true,
      targetWindowId: 2
    })
    expect(h.calls.slice(0, 2)).toEqual(['set:2', 'handoff:101->102'])
    expect(h.target.webContents.send).toHaveBeenCalledWith(
      'terminalWindow:command',
      expect.objectContaining({ phase: 'target-import' })
    )
    expect(h.source.webContents.send).toHaveBeenCalledWith(
      'terminalWindow:command',
      expect.objectContaining({ phase: 'source-remove' })
    )
    const targetCommand = h.target.webContents.send.mock.calls[0]?.[1]
    const sourceCommand = h.source.webContents.send.mock.calls[0]?.[1]
    expect(targetCommand.transferId).toEqual(expect.any(String))
    expect(targetCommand.transferId).not.toBe('')
    expect(sourceCommand.transferId).toBe(targetCommand.transferId)
    expect(h.owners.owns('pty-1', h.target.webContents as never)).toBe(true)
    expect(h.target.show).not.toHaveBeenCalled()
  })

  it('settles only the current well-formed ACK for the exact transfer', async () => {
    const h = createHarness()
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    let coordinator!: InstanceType<typeof TerminalWindowTransferCoordinator>
    coordinator = new TerminalWindowTransferCoordinator({
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
      queueMicrotask(() => {
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
          ...command,
          ok: false,
          error: 'invalid_ack_settled',
          empty: 'yes'
        })
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
          ...command,
          transferId: 'stale-transfer',
          ok: false,
          error: 'stale_ack_settled'
        })
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
          ...command,
          ok: true
        })
      })
    })
    h.source.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.source.webContents) as never, {
          ...command,
          ok: true
        })
      )
    })
    coordinator.getContext(ipcEvent(h.target.webContents) as never)

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, seed())
    ).resolves.toEqual({ ok: true, targetWindowId: 2 })
  })

  it('rejects a mismatched target without moving ownership', async () => {
    const h = createHarness({ targetMatching: false })
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    let coordinator!: InstanceType<typeof TerminalWindowTransferCoordinator>
    coordinator = new TerminalWindowTransferCoordinator({
      store: {} as never,
      createSecondaryWindow: vi.fn(),
      windows: h.windows,
      sessions: h.sessions as never,
      owners: h.owners,
      getCursorPoint: () => ({ x: 700, y: 100 }),
      handoff: h.handoff,
      timeoutMs: 10
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, seed())
    ).resolves.toEqual({
      ok: false,
      error: 'terminal_transfer_target_mismatch'
    })
    expect(h.handoff).not.toHaveBeenCalled()
    expect(h.owners.owns('pty-1', h.source.webContents as never)).toBe(true)
  })

  it('rejects duplicate PTY ids before staging the target', async () => {
    const h = createHarness()
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    const coordinator = new TerminalWindowTransferCoordinator({
      store: {} as never,
      createSecondaryWindow: vi.fn(),
      windows: h.windows,
      sessions: h.sessions as never,
      owners: h.owners,
      getCursorPoint: () => ({ x: 700, y: 100 }),
      handoff: h.handoff,
      timeoutMs: 10
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, {
        ...seed(),
        ptyIds: ['pty-1', 'pty-1']
      })
    ).resolves.toEqual({ ok: false, error: 'invalid_terminal_transfer_seed' })
    expect(h.sessions.set).not.toHaveBeenCalled()
    expect(h.handoff).not.toHaveBeenCalled()
  })

  it('rejects a malformed terminal layout before staging the target', async () => {
    const h = createHarness()
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    const coordinator = new TerminalWindowTransferCoordinator({
      store: {} as never,
      createSecondaryWindow: vi.fn(),
      windows: h.windows,
      sessions: h.sessions as never,
      owners: h.owners,
      getCursorPoint: () => ({ x: 700, y: 100 }),
      handoff: h.handoff,
      timeoutMs: 10
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, {
        ...seed(),
        layout: { root: { type: 'leaf' }, ptyIdsByLeafId: { 'leaf-1': 'pty-1' } }
      })
    ).resolves.toEqual({ ok: false, error: 'invalid_terminal_transfer_seed' })
    expect(h.sessions.set).not.toHaveBeenCalled()
    expect(h.handoff).not.toHaveBeenCalled()
  })

  it('rejects a source record missing the terminal layout before staging', async () => {
    const h = createHarness()
    h.records.set(h.source.id, { ...session(true), terminalLayoutsByTabId: {} })
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    const coordinator = new TerminalWindowTransferCoordinator({
      store: {} as never,
      createSecondaryWindow: vi.fn(),
      windows: h.windows,
      sessions: h.sessions as never,
      owners: h.owners,
      getCursorPoint: () => ({ x: 700, y: 100 }),
      handoff: h.handoff,
      timeoutMs: 10
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, seed())
    ).resolves.toEqual({ ok: false, error: 'terminal_transfer_source_missing' })
    expect(h.sessions.set).not.toHaveBeenCalled()
    expect(h.handoff).not.toHaveBeenCalled()
  })

  it('rejects a source workspace identity mismatch before staging', async () => {
    const h = createHarness()
    h.records.set(h.source.id, session(true, false))
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    const coordinator = new TerminalWindowTransferCoordinator({
      store: {} as never,
      createSecondaryWindow: vi.fn(),
      windows: h.windows,
      sessions: h.sessions as never,
      owners: h.owners,
      getCursorPoint: () => ({ x: 700, y: 100 }),
      handoff: h.handoff,
      timeoutMs: 10
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, seed())
    ).resolves.toEqual({ ok: false, error: 'terminal_transfer_source_mismatch' })
    expect(h.sessions.set).not.toHaveBeenCalled()
    expect(h.handoff).not.toHaveBeenCalled()
  })

  it('rejects detach and context requests from an obsolete renderer frame', async () => {
    const h = createHarness()
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    const coordinator = new TerminalWindowTransferCoordinator({
      store: {} as never,
      createSecondaryWindow: vi.fn(),
      windows: h.windows,
      sessions: h.sessions as never,
      owners: h.owners,
      getCursorPoint: () => ({ x: 700, y: 100 }),
      handoff: h.handoff,
      timeoutMs: 10
    })
    const obsoleteFrame = ipcEvent(h.source.webContents, {})

    expect(() => coordinator.getContext(obsoleteFrame as never)).toThrow('untrusted_ui_renderer')
    await expect(coordinator.detach(obsoleteFrame as never, seed())).resolves.toEqual({
      ok: false,
      error: 'untrusted_ui_renderer'
    })
    expect(h.handoff).not.toHaveBeenCalled()
  })

  it('does not settle a transfer waiter from an obsolete-frame ACK', async () => {
    const h = createHarness()
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    const coordinator = new TerminalWindowTransferCoordinator({
      store: {} as never,
      createSecondaryWindow: vi.fn(),
      windows: h.windows,
      sessions: h.sessions as never,
      owners: h.owners,
      getCursorPoint: () => ({ x: 700, y: 100 }),
      handoff: h.handoff,
      timeoutMs: 1
    })
    h.target.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.target.webContents, {}) as never, {
          ...command,
          ok: true
        })
      )
    })
    coordinator.getContext(ipcEvent(h.target.webContents) as never)

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, seed())
    ).resolves.toEqual({ ok: false, error: 'terminal_transfer_target-import_timeout' })
  })

  it('does not reuse command readiness from an old WebContents with the same id', async () => {
    const h = createHarness()
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
    coordinator.getContext(ipcEvent(h.target.webContents) as never)

    h.windows.remove(h.target.id)
    h.owners.removeRenderer(h.target.webContents as never)
    const replacement = new FakeWindow(3, h.target.bounds, h.target.webContents.id)
    h.windows.register(replacement as never, 'secondary')
    h.owners.registerRenderer(replacement.webContents as never)
    h.owners.markDispatcherReady(replacement.webContents as never)
    h.records.set(replacement.id, session(false))

    const pending = coordinator.detach(ipcEvent(h.source.webContents) as never, seed())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replacement.webContents.send).not.toHaveBeenCalled()

    replacement.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(replacement.webContents) as never, {
          ...command,
          ok: true
        })
      )
    })
    h.source.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.source.webContents) as never, { ...command, ok: true })
      )
    })
    coordinator.getContext(ipcEvent(replacement.webContents) as never)
    await expect(pending).resolves.toEqual({ ok: true, targetWindowId: replacement.id })
  })

  it('ignores loading from an old WebContents after a same-id replacement is ready', async () => {
    const h = createHarness()
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    const coordinator = new TerminalWindowTransferCoordinator({
      store: {} as never,
      createSecondaryWindow: vi.fn(),
      windows: h.windows,
      sessions: h.sessions as never,
      owners: h.owners,
      getCursorPoint: () => ({ x: 700, y: 100 }),
      handoff: h.handoff,
      timeoutMs: 10
    })
    coordinator.getContext(ipcEvent(h.target.webContents) as never)

    h.windows.remove(h.target.id)
    h.owners.removeRenderer(h.target.webContents as never)
    const replacement = new FakeWindow(3, h.target.bounds, h.target.webContents.id)
    h.windows.register(replacement as never, 'secondary')
    h.owners.registerRenderer(replacement.webContents as never)
    h.owners.markDispatcherReady(replacement.webContents as never)
    h.records.set(replacement.id, session(false))
    coordinator.getContext(ipcEvent(replacement.webContents) as never)
    h.target.webContents.emit('did-start-loading')
    replacement.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(replacement.webContents) as never, {
          ...command,
          ok: true
        })
      )
    })
    h.source.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.source.webContents) as never, { ...command, ok: true })
      )
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, seed())
    ).resolves.toEqual({ ok: true, targetWindowId: replacement.id })
  })

  it('reverses ownership and restores records when target import fails', async () => {
    const h = createHarness()
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
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
          ...command,
          ok: command.phase === 'target-remove'
        })
      )
    })
    h.source.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.source.webContents) as never, {
          ...command,
          ok: true
        })
      )
    })
    coordinator.getContext(ipcEvent(h.target.webContents) as never)

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, seed())
    ).resolves.toEqual({
      ok: false,
      error: 'terminal_transfer_target-import_failed'
    })
    expect(h.handoff).toHaveBeenCalledTimes(2)
    expect(h.owners.owns('pty-1', h.source.webContents as never)).toBe(true)
    expect(h.records.get(h.source.id)).toEqual(session(true))
    expect(h.records.get(h.target.id)).toEqual(session(false))
  })

  it('creates a hidden target inside the cursor display and reveals it after commit', async () => {
    const h = createHarness({ createTarget: true })
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    const createSecondaryWindow = vi.fn(() => {
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
      getCursorPoint: () => ({ x: 1900, y: 100 }),
      getWorkArea: () => ({ x: 1440, y: 0, width: 1440, height: 900 }),
      registerRenderer: vi.fn(() => vi.fn()),
      loadWindow: vi.fn(() => coordinator.getContext(ipcEvent(h.target.webContents) as never)),
      handoff: h.handoff,
      timeoutMs: 100
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
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.source.webContents) as never, {
          ...command,
          ok: true
        })
      )
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, seed())
    ).resolves.toEqual({
      ok: true,
      targetWindowId: 2
    })
    expect(createSecondaryWindow).toHaveBeenCalledWith({
      x: 1440,
      y: 76,
      width: 1200,
      height: 800
    })
    expect(h.target.show).toHaveBeenCalledOnce()
    expect(h.target.focus).toHaveBeenCalledOnce()
  })

  it('keeps the original transfer error when rollback destroys a created target', async () => {
    const h = createHarness({ createTarget: true })
    const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
    const createSecondaryWindow = vi.fn(() => {
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
      loadWindow: vi.fn(() => coordinator.getContext(ipcEvent(h.target.webContents) as never)),
      handoff: h.handoff,
      timeoutMs: 100
    })
    h.target.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
          ...command,
          ok: command.phase === 'target-remove'
        })
      )
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, seed())
    ).resolves.toEqual({
      ok: false,
      error: 'terminal_transfer_target-import_failed'
    })
    expect(h.target.destroy).toHaveBeenCalledOnce()
  })
})
