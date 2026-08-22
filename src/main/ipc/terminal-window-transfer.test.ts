import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { TerminalWindowTransferSeed } from '../../shared/terminal-window-transfer'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaWindowManager } from '../window/orca-window-manager'
import { PtyRendererOwners } from './pty-renderer-owners'
import { sessionMatchesTerminalWindowTarget } from './terminal-window-transfer-operation'

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

class FakeWebContents extends EventEmitter {
  readonly id: number
  readonly send = vi.fn()
  destroyed = false

  constructor(id: number) {
    super()
    this.id = id
  }

  getType(): string {
    return 'window'
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

class FakeWindow extends EventEmitter {
  readonly id: number
  readonly #webContents: FakeWebContents
  bounds: Electron.Rectangle
  visible = true
  destroyed = false
  readonly show = vi.fn()
  readonly focus = vi.fn()
  readonly close = vi.fn()
  readonly destroy = vi.fn(() => {
    this.destroyed = true
  })

  constructor(id: number, bounds: Electron.Rectangle) {
    super()
    this.id = id
    this.bounds = bounds
    this.#webContents = new FakeWebContents(id + 100)
  }

  get webContents(): FakeWebContents {
    if (this.destroyed) {
      throw new Error('Object has been destroyed')
    }
    return this.#webContents
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isVisible(): boolean {
    return this.visible
  }

  getBounds(): Electron.Rectangle {
    return this.bounds
  }
}

function seed(): TerminalWindowTransferSeed {
  return {
    tabId: 'tab-1',
    hostId: 'local',
    canonicalWorkspaceKey: 'worktree:wt-1',
    worktreeId: 'wt-1',
    repo: { id: 'repo-1' } as never,
    group: {
      id: 'group-1',
      worktreeId: 'wt-1',
      activeTabId: 'tab-1',
      tabOrder: ['tab-1'],
      recentTabIds: ['tab-1']
    },
    tab: { id: 'tab-1', worktreeId: 'wt-1', title: 'Terminal' } as never,
    layout: {
      root: { type: 'leaf', id: 'leaf-1' },
      ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
    } as never,
    ptyIds: ['pty-1']
  }
}

function session(withTab: boolean, matching = true): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo-1',
    activeWorkspaceKey: matching ? 'worktree:wt-1' : 'worktree:other',
    activeWorkspaceExecutionHostId: 'local',
    activeWorktreeId: 'wt-1',
    tabsByWorktree: withTab ? { 'wt-1': [seed().tab] } : {},
    terminalLayoutsByTabId: withTab ? { 'tab-1': seed().layout } : {}
  }
}

function createHarness(options: { targetMatching?: boolean; createTarget?: boolean } = {}) {
  const windows = new OrcaWindowManager()
  const source = new FakeWindow(1, { x: 0, y: 0, width: 500, height: 500 })
  const target = new FakeWindow(2, { x: 600, y: 0, width: 500, height: 500 })
  windows.register(source as never, 'control')
  if (!options.createTarget) {
    windows.register(target as never, 'secondary')
  }
  const owners = new PtyRendererOwners()
  owners.registerRenderer(source.webContents as never)
  owners.registerRenderer(target.webContents as never)
  owners.markDispatcherReady(source.webContents as never)
  owners.markDispatcherReady(target.webContents as never)
  owners.claim('pty-1', source.webContents as never)
  const records = new Map<number, WorkspaceSessionState>([
    [source.id, session(true)],
    [target.id, session(false, options.targetMatching !== false)]
  ])
  const calls: string[] = []
  const sessions = {
    get: vi.fn((windowId: number) => structuredClone(records.get(windowId)!)),
    set: vi.fn((windowId: number, state: WorkspaceSessionState) => {
      calls.push(`set:${windowId}`)
      records.set(windowId, structuredClone(state))
    }),
    seedWindow: vi.fn(),
    retire: vi.fn()
  }
  const handoff = vi.fn((ids, from, to) => {
    calls.push(`handoff:${from.id}->${to.id}`)
    owners.handoff(ids, from, to)
  })
  return { windows, source, target, owners, records, sessions, calls, handoff }
}

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
    expect(coordinator.getContext(h.source.webContents as never).transitionFenced).toBe(true)
    coordinator.resumeAfterQuitAbort()
    expect(coordinator.getContext(h.source.webContents as never).transitionFenced).toBe(false)
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
        coordinator.acknowledge(h.target.webContents as never, { ...command, ok: true })
      )
    })
    h.source.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(h.source.webContents as never, { ...command, ok: true })
      )
    })
    coordinator.getContext(h.target.webContents as never)

    await expect(coordinator.detach(h.source.webContents as never, seed())).resolves.toEqual({
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
    expect(h.owners.owns('pty-1', h.target.webContents as never)).toBe(true)
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

    await expect(coordinator.detach(h.source.webContents as never, seed())).resolves.toEqual({
      ok: false,
      error: 'terminal_transfer_target_mismatch'
    })
    expect(h.handoff).not.toHaveBeenCalled()
    expect(h.owners.owns('pty-1', h.source.webContents as never)).toBe(true)
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
        coordinator.acknowledge(h.target.webContents as never, {
          ...command,
          ok: command.phase === 'target-remove'
        })
      )
    })
    h.source.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(h.source.webContents as never, { ...command, ok: true })
      )
    })
    coordinator.getContext(h.target.webContents as never)

    await expect(coordinator.detach(h.source.webContents as never, seed())).resolves.toEqual({
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
      loadWindow: vi.fn(() => coordinator.getContext(h.target.webContents as never)),
      handoff: h.handoff,
      timeoutMs: 100
    })
    h.target.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(h.target.webContents as never, { ...command, ok: true })
      )
    })
    h.source.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(h.source.webContents as never, { ...command, ok: true })
      )
    })

    await expect(coordinator.detach(h.source.webContents as never, seed())).resolves.toEqual({
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
      loadWindow: vi.fn(() => coordinator.getContext(h.target.webContents as never)),
      handoff: h.handoff,
      timeoutMs: 100
    })
    h.target.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(h.target.webContents as never, {
          ...command,
          ok: command.phase === 'target-remove'
        })
      )
    })

    await expect(coordinator.detach(h.source.webContents as never, seed())).resolves.toEqual({
      ok: false,
      error: 'terminal_transfer_target-import_failed'
    })
    expect(h.target.destroy).toHaveBeenCalledOnce()
  })
})
