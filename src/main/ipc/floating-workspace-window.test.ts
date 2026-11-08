import { beforeEach, describe, expect, it, vi } from 'vitest'

type Sender = { id: number; role: 'main' | 'floating' | 'dashboard' | 'other' }

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handlers,
    showWindow: vi.fn(),
    hideWindow: vi.fn(),
    destroyWindow: vi.fn(),
    sendToTrusted: vi.fn(),
    sendToWindow: vi.fn(),
    windowListeners: new Set<(event: 'user-hidden' | 'destroyed') => void>()
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, fn),
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, fn),
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
    removeAllListeners: (channel: string) => mocks.handlers.delete(channel)
  }
}))
vi.mock('./ui', () => ({
  isTrustedUIRenderer: (sender: Sender) => sender.role === 'main',
  sendToTrustedUIRenderer: mocks.sendToTrusted
}))
vi.mock('../window/dashboard-popout-window', () => ({
  isDashboardPopoutRenderer: (sender: Sender) => sender.role === 'dashboard'
}))
vi.mock('../window/floating-workspace-window', () => ({
  showFloatingWorkspaceWindow: mocks.showWindow,
  hideFloatingWorkspaceWindow: mocks.hideWindow,
  destroyFloatingWorkspaceWindow: mocks.destroyWindow,
  getFloatingWorkspaceWindow: () => ({ webContents: { send: mocks.sendToWindow } }),
  isFloatingWorkspaceWindowRenderer: (sender: Sender) => sender.role === 'floating',
  onFloatingWorkspaceWindowEvent: (listener: (event: 'user-hidden' | 'destroyed') => void) => {
    mocks.windowListeners.add(listener)
    return () => mocks.windowListeners.delete(listener)
  }
}))
vi.mock('./renderer-lifetime-abort', () => ({
  abortWhenRendererGone: () => ({ signal: new AbortController().signal, dispose: vi.fn() })
}))

import {
  getFloatingWorkspaceAdmittedPtyId,
  registerFloatingWorkspaceWindowHandlers
} from './floating-workspace-window'
import { registerTerminalPreviewHandlers } from './terminal-preview'

const MAIN: Sender = { id: 1, role: 'main' }
const FLOATING: Sender = { id: 2, role: 'floating' }
const DASHBOARD: Sender = { id: 3, role: 'dashboard' }
const OTHER: Sender = { id: 4, role: 'other' }

const FLOATING_PTY = 'global-floating-terminal@@floating-1'
const SECOND_FLOATING_PTY = 'global-floating-terminal@@floating-2'
const OTHER_PTY = 'wt-1::/tmp/repo@@main-1'

function snapshotFor(ptyId: string | null): unknown {
  return {
    version: 1,
    activeTab: {
      tabId: 'tab-1',
      title: 'Terminal',
      kind: 'terminal',
      status: 'idle',
      paneKey: 'tab-1:leaf-1',
      ptyId
    }
  }
}

function call(channel: string, sender: Sender, ...args: unknown[]): unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }
  return handler({ sender }, ...args)
}

function makeRuntime(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    registerRawTerminalViewSubscriber: vi.fn(() => vi.fn()),
    subscribeToTerminalData: vi.fn(() => vi.fn()),
    subscribeToTerminalResize: vi.fn(() => vi.fn()),
    getTerminalSize: vi.fn(() => ({ cols: 80, rows: 24 })),
    serializeTerminalBuffer: vi.fn(async () => null),
    writeTerminalPreviewInput: vi.fn(async () => true),
    updateRemoteDesktopViewer: vi.fn(async () => true),
    unregisterRemoteDesktopViewer: vi.fn(async () => undefined)
  }
}

describe('floating workspace window IPC', () => {
  let settings: Record<string, unknown>

  beforeEach(() => {
    mocks.handlers.clear()
    mocks.windowListeners.clear()
    vi.clearAllMocks()
    settings = { floatingTerminalEnabled: true, experimentalFloatingWorkspacePopout: true }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the Store methods the handlers use.
    const store = {
      getSettings: () => settings,
      onSettingsChanged: vi.fn()
    } as unknown as Parameters<typeof registerFloatingWorkspaceWindowHandlers>[0]
    registerFloatingWorkspaceWindowHandlers(store)
    for (const listener of mocks.windowListeners) {
      listener('destroyed')
    }
  })

  it('rejects show, hide, destroy and publish from a non-main sender', () => {
    for (const sender of [FLOATING, DASHBOARD, OTHER]) {
      call('floatingWorkspaceWindow:show', sender, { focus: true })
      call('floatingWorkspaceWindow:hide', sender)
      call('floatingWorkspaceWindow:destroy', sender)
      call('floatingWorkspaceWindow:publishSnapshot', sender, snapshotFor(FLOATING_PTY))
    }
    expect(mocks.showWindow).not.toHaveBeenCalled()
    expect(mocks.hideWindow).not.toHaveBeenCalled()
    expect(mocks.destroyWindow).not.toHaveBeenCalled()
    expect(getFloatingWorkspaceAdmittedPtyId()).toBeNull()

    call('floatingWorkspaceWindow:show', MAIN, { focus: true })
    call('floatingWorkspaceWindow:hide', MAIN)
    call('floatingWorkspaceWindow:destroy', MAIN)
    call('floatingWorkspaceWindow:publishSnapshot', MAIN, snapshotFor(FLOATING_PTY))
    expect(mocks.showWindow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ focus: true })
    )
    expect(mocks.hideWindow).toHaveBeenCalledTimes(1)
    expect(mocks.destroyWindow).toHaveBeenCalledTimes(1)
    expect(getFloatingWorkspaceAdmittedPtyId()).toBe(FLOATING_PTY)
  })

  it('rejects show while the experimental flag is off', () => {
    settings.experimentalFloatingWorkspacePopout = false
    call('floatingWorkspaceWindow:show', MAIN, { focus: false })
    expect(mocks.showWindow).not.toHaveBeenCalled()

    settings.experimentalFloatingWorkspacePopout = true
    settings.floatingTerminalEnabled = false
    call('floatingWorkspaceWindow:show', MAIN, { focus: false })
    expect(mocks.showWindow).not.toHaveBeenCalled()

    settings.floatingTerminalEnabled = true
    call('floatingWorkspaceWindow:show', MAIN, { focus: false })
    expect(mocks.showWindow).toHaveBeenCalledTimes(1)
  })

  it("forwards a floating-window ack once, on its own channel, only for the snapshot's active pane", () => {
    call('floatingWorkspaceWindow:publishSnapshot', MAIN, snapshotFor(FLOATING_PTY))
    call('floatingWorkspaceWindow:ackAgent', FLOATING, { paneKey: 'tab-1:leaf-2', intent: 'view' })
    call('floatingWorkspaceWindow:ackAgent', MAIN, { paneKey: 'tab-1:leaf-1', intent: 'view' })
    call('floatingWorkspaceWindow:ackAgent', FLOATING, { paneKey: 'tab-1:leaf-1', intent: 'view' })
    expect(mocks.sendToTrusted.mock.calls).toEqual([
      ['floatingWorkspaceWindow:agentAcked', { paneKey: 'tab-1:leaf-1', intent: 'view' }]
    ])
  })

  describe('terminalPreview scoping', () => {
    let runtime: ReturnType<typeof makeRuntime>

    beforeEach(() => {
      runtime = makeRuntime()
      registerTerminalPreviewHandlers(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the runtime methods the preview handlers use.
        runtime as unknown as Parameters<typeof registerTerminalPreviewHandlers>[0]
      )
    })

    const connect = (sender: Sender, ptyId: string): unknown =>
      call('terminalPreview:connect', sender, { ptyId })
    const input = (sender: Sender, ptyId: string): unknown =>
      call('terminalPreview:input', sender, { ptyId, data: 'x' })
    const fit = (sender: Sender, ptyId: string): unknown =>
      call('terminalPreview:fit', sender, { ptyId, cols: 80, rows: 24 })

    it('refuses terminalPreview connect, input and fit for a ptyId absent from the last admitted snapshot, accepts it once a snapshot names it', async () => {
      await connect(FLOATING, FLOATING_PTY)
      expect(await input(FLOATING, FLOATING_PTY)).toBe(false)
      expect(await fit(FLOATING, FLOATING_PTY)).toBeNull()
      expect(runtime.registerRawTerminalViewSubscriber).not.toHaveBeenCalled()
      expect(runtime.writeTerminalPreviewInput).not.toHaveBeenCalled()
      expect(runtime.updateRemoteDesktopViewer).not.toHaveBeenCalled()

      call('floatingWorkspaceWindow:publishSnapshot', MAIN, snapshotFor(FLOATING_PTY))

      await connect(FLOATING, 'global-floating-terminal@@stale')
      expect(await input(FLOATING, 'global-floating-terminal@@stale')).toBe(false)
      expect(runtime.registerRawTerminalViewSubscriber).not.toHaveBeenCalled()

      await connect(FLOATING, FLOATING_PTY)
      expect(await input(FLOATING, FLOATING_PTY)).toBe(true)
      await fit(FLOATING, FLOATING_PTY)
      expect(runtime.registerRawTerminalViewSubscriber).toHaveBeenCalledWith(FLOATING_PTY)
      expect(runtime.writeTerminalPreviewInput).toHaveBeenCalledWith(FLOATING_PTY, 'x')
      expect(runtime.updateRemoteDesktopViewer).toHaveBeenCalledTimes(1)

      call('floatingWorkspaceWindow:publishSnapshot', MAIN, snapshotFor(SECOND_FLOATING_PTY))
      runtime.registerRawTerminalViewSubscriber.mockClear()
      runtime.writeTerminalPreviewInput.mockClear()
      runtime.updateRemoteDesktopViewer.mockClear()

      await connect(FLOATING, FLOATING_PTY)
      expect(await input(FLOATING, FLOATING_PTY)).toBe(false)
      expect(await fit(FLOATING, FLOATING_PTY)).toBeNull()
      expect(runtime.registerRawTerminalViewSubscriber).not.toHaveBeenCalled()
      expect(runtime.writeTerminalPreviewInput).not.toHaveBeenCalled()
      expect(runtime.updateRemoteDesktopViewer).not.toHaveBeenCalled()

      await connect(FLOATING, SECOND_FLOATING_PTY)
      expect(await input(FLOATING, SECOND_FLOATING_PTY)).toBe(true)
      await fit(FLOATING, SECOND_FLOATING_PTY)
      expect(runtime.registerRawTerminalViewSubscriber).toHaveBeenCalledWith(SECOND_FLOATING_PTY)
      expect(runtime.updateRemoteDesktopViewer).toHaveBeenCalledTimes(1)

      // The dashboard and main renderer keep today's rules: any PTY id.
      expect(await input(DASHBOARD, OTHER_PTY)).toBe(true)
      expect(await input(MAIN, OTHER_PTY)).toBe(true)
      expect(await input(OTHER, OTHER_PTY)).toBe(false)
    })

    it('drops a snapshot that names a PTY owned by another workspace, so the window cannot type into it', async () => {
      call('floatingWorkspaceWindow:publishSnapshot', MAIN, snapshotFor(OTHER_PTY))

      expect(getFloatingWorkspaceAdmittedPtyId()).toBeNull()
      expect(await input(FLOATING, OTHER_PTY)).toBe(false)
      expect(runtime.writeTerminalPreviewInput).not.toHaveBeenCalled()
    })
  })
})
