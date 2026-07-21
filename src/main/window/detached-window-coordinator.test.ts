import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetachedTerminalOpenSnapshot } from '../../shared/detached-terminal-window'
import type { TerminalPaneLayoutNode } from '../../shared/types'
import { makePaneKey } from '../../shared/stable-pane-id'

const mocks = vi.hoisted(() => {
  let nextWebContentsId = 100
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []
    webContents = {
      id: nextWebContentsId++,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn()
    }
    closed = false
    destroyed = false
    focused = false
    shown = false
    listeners = new Map<string, () => void>()
    constructor(public readonly opts: Record<string, unknown>) {
      FakeBrowserWindow.instances.push(this)
    }
    once(event: string, listener: () => void): void {
      this.listeners.set(event, listener)
    }
    on(event: string, listener: () => void): void {
      this.listeners.set(event, listener)
    }
    loadURL = vi.fn()
    loadFile = vi.fn()
    show(): void {
      this.shown = true
    }
    focus(): void {
      this.focused = true
    }
    close(): void {
      this.closed = true
      this.listeners.get('closed')?.()
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
  }
  return {
    FakeBrowserWindow,
    ipcHandlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
    paneBindings: new Map<string, string>()
  }
})

vi.mock('electron', () => ({
  BrowserWindow: mocks.FakeBrowserWindow,
  nativeTheme: { shouldUseDarkColors: true },
  ipcMain: {
    removeHandler: vi.fn((channel: string) => mocks.ipcHandlers.delete(channel)),
    handle: vi.fn((channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      mocks.ipcHandlers.set(channel, handler)
    })
  }
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../app-icon', () => ({ getAppIconPath: () => 'icon.png' }))
vi.mock('../ipc/pty', () => ({
  getPtyIdForPaneKey: (paneKey: string) => mocks.paneBindings.get(paneKey)
}))

const leaf = '11111111-1111-4111-8111-111111111111'
const secondLeaf = '22222222-2222-4222-8222-222222222222'

function baseSnapshot(
  root: TerminalPaneLayoutNode = { type: 'leaf', leafId: leaf }
): DetachedTerminalOpenSnapshot {
  return {
    worktree: { id: 'wt-1', repoId: 'repo-1', path: '/tmp/wt' } as never,
    terminalTab: {
      id: 'tab-1',
      ptyId: 'pty-1',
      worktreeId: 'wt-1',
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    },
    unifiedTab: {
      id: 'unified-1',
      entityId: 'tab-1',
      groupId: 'group-1',
      worktreeId: 'wt-1',
      contentType: 'terminal',
      label: 'Terminal',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    },
    group: { id: 'group-1', worktreeId: 'wt-1', activeTabId: 'unified-1', tabOrder: ['unified-1'] },
    groupLayout: { type: 'leaf', groupId: 'group-1' },
    terminalLayout: {
      root,
      activeLeafId: root.type === 'leaf' ? root.leafId : leaf,
      expandedLeafId: null,
      ptyIdsByLeafId: { [leaf]: 'pty-1' }
    },
    activeGroupId: 'group-1',
    activeTabId: 'unified-1',
    repos: [{ id: 'repo-1', path: '/tmp/repo' } as never],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/tmp/wt' } as never] },
    bufferSnapshotsByLeafId: {},
    settings: {} as never,
    keybindings: null
  }
}

async function importCoordinator() {
  return import('./detached-window-coordinator')
}

describe('detached-window-coordinator', () => {
  beforeEach(async () => {
    vi.resetModules()
    mocks.FakeBrowserWindow.instances.length = 0
    mocks.ipcHandlers.clear()
    mocks.paneBindings.clear()
    mocks.paneBindings.set(makePaneKey('tab-1', leaf), 'pty-1')
  })

  async function allowMainSenderToOpenDetachedPty(ptyId = 'pty-1'): Promise<void> {
    const { paneOwnershipRegistry } = await import('./pane-ownership-registry')
    const { trustedRendererRegistry } = await import('./trusted-renderer-registry')
    paneOwnershipRegistry.setPrimaryAppWebContentsId(1)
    trustedRendererRegistry.grant(1, 'pty')
    mocks.paneBindings.set(makePaneKey('tab-1', leaf), ptyId)
  }

  it('focuses an existing detached terminal window for the same worktree tab', async () => {
    const { openDetachedTerminalWindow } = await importCoordinator()
    const snapshot = baseSnapshot()

    const first = openDetachedTerminalWindow({ worktreeId: 'wt-1', tabId: 'tab-1', snapshot })
    const second = openDetachedTerminalWindow({ worktreeId: 'wt-1', tabId: 'tab-1', snapshot })

    expect(second).toBe(first)
    expect(mocks.FakeBrowserWindow.instances).toHaveLength(1)
    expect((first as never as InstanceType<typeof mocks.FakeBrowserWindow>).focused).toBe(true)
  })

  it('stages a fresh renderer snapshot instead of reading debounced persisted session state', async () => {
    const { openDetachedTerminalWindow } = await importCoordinator()
    const { detachedWindowRegistry } = await import('./detached-window-registry')
    const snapshot = baseSnapshot()
    snapshot.terminalTab.title = 'Fresh renderer title'

    openDetachedTerminalWindow({ worktreeId: 'wt-1', tabId: 'tab-1', snapshot })

    expect(
      detachedWindowRegistry.getDetachedTerminalSnapshot({ worktreeId: 'wt-1', tabId: 'tab-1' })
        ?.terminalTab.title
    ).toBe('Fresh renderer title')
  })

  it('registers every split-pane PTY in the detached tab', async () => {
    const root: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: leaf },
      second: { type: 'leaf', leafId: secondLeaf }
    }
    const snapshot = baseSnapshot(root)
    snapshot.terminalLayout.ptyIdsByLeafId = { [leaf]: 'pty-1', [secondLeaf]: 'pty-2' }
    mocks.paneBindings.set(makePaneKey('tab-1', secondLeaf), 'pty-2')
    const { openDetachedTerminalWindow } = await importCoordinator()
    const { detachedWindowRegistry } = await import('./detached-window-registry')

    openDetachedTerminalWindow({ worktreeId: 'wt-1', tabId: 'tab-1', snapshot })

    expect(
      detachedWindowRegistry.getDetachedTerminalSnapshot({ worktreeId: 'wt-1', tabId: 'tab-1' })
        ?.ptyIds
    ).toEqual(['pty-1', 'pty-2'])
  })

  it('rejects a split snapshot when terminalTab.ptyId is missing from the layout bindings', async () => {
    const root: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: leaf },
      second: { type: 'leaf', leafId: secondLeaf }
    }
    const snapshot = baseSnapshot(root)
    snapshot.terminalTab.ptyId = 'pty-orphan'
    snapshot.terminalLayout.ptyIdsByLeafId = { [leaf]: 'pty-1', [secondLeaf]: 'pty-2' }
    mocks.paneBindings.set(makePaneKey('tab-1', secondLeaf), 'pty-2')
    mocks.paneBindings.set(makePaneKey('tab-1', leaf), 'pty-1')
    await allowMainSenderToOpenDetachedPty()
    const { registerDetachedTerminalHandlers } = await importCoordinator()
    registerDetachedTerminalHandlers()

    const result = await mocks.ipcHandlers.get('detachedTerminal:openWindow')?.(
      { sender: { id: 1 } },
      { worktreeId: 'wt-1', tabId: 'tab-1', snapshot }
    )

    expect(result).toEqual({ ok: false, error: 'detached_terminal_tab_unavailable' })
  })

  it('rejects a snapshot whose PTY ids do not match makePaneKey(tabId, leafId) bindings in the main PTY runtime', async () => {
    const { registerDetachedTerminalHandlers } = await importCoordinator()
    registerDetachedTerminalHandlers()
    await allowMainSenderToOpenDetachedPty()
    const result = await mocks.ipcHandlers.get('detachedTerminal:openWindow')?.(
      { sender: { id: 1 } },
      {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        snapshot: {
          ...baseSnapshot(),
          terminalLayout: { ...baseSnapshot().terminalLayout, ptyIdsByLeafId: { [leaf]: 'wrong' } }
        }
      }
    )

    expect(result).toEqual({ ok: false, error: 'detached_terminal_tab_unavailable' })
  })

  it('rejects detached open requests for PTYs the sender does not own', async () => {
    const { registerDetachedTerminalHandlers } = await importCoordinator()
    const { trustedRendererRegistry } = await import('./trusted-renderer-registry')
    trustedRendererRegistry.grant(1, 'pty')
    registerDetachedTerminalHandlers()

    const result = await mocks.ipcHandlers.get('detachedTerminal:openWindow')?.(
      { sender: { id: 1, isDestroyed: () => false } },
      { worktreeId: 'wt-1', tabId: 'tab-1', snapshot: baseSnapshot() }
    )

    expect(result).toEqual({ ok: false, error: 'detached_terminal_tab_unavailable' })
    expect(mocks.FakeBrowserWindow.instances).toHaveLength(0)
  })

  it('closing a detached terminal window keeps the PTY owner alive in the main tab', async () => {
    const { openDetachedTerminalWindow, registerDetachedTerminalHandlers } =
      await importCoordinator()
    const { paneOwnershipRegistry } = await import('./pane-ownership-registry')
    registerDetachedTerminalHandlers()
    const window = openDetachedTerminalWindow({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      snapshot: baseSnapshot()
    }) as never as InstanceType<typeof mocks.FakeBrowserWindow>
    await mocks.ipcHandlers.get('detachedTerminal:rendererPtyReady')?.(
      { sender: { id: window.webContents.id } },
      { worktreeId: 'wt-1', tabId: 'tab-1', ptyId: 'pty-1' }
    )

    window.close()

    expect(paneOwnershipRegistry.getOwnerForPty('pty-1')).toBeNull()
  })

  it('allows the detached window to close itself', async () => {
    const { openDetachedTerminalWindow, registerDetachedTerminalHandlers } =
      await importCoordinator()
    await allowMainSenderToOpenDetachedPty()
    registerDetachedTerminalHandlers()
    const window = openDetachedTerminalWindow({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      snapshot: baseSnapshot()
    }) as never as InstanceType<typeof mocks.FakeBrowserWindow>

    await mocks.ipcHandlers.get('detachedTerminal:closeWindow')?.(
      { sender: { id: window.webContents.id } },
      { worktreeId: 'wt-1', tabId: 'tab-1' }
    )

    expect(window.closed).toBe(true)
  })

  it('ignores detached close requests from unrelated renderers', async () => {
    const { openDetachedTerminalWindow, registerDetachedTerminalHandlers } =
      await importCoordinator()
    registerDetachedTerminalHandlers()
    const window = openDetachedTerminalWindow({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      snapshot: baseSnapshot()
    }) as never as InstanceType<typeof mocks.FakeBrowserWindow>

    await mocks.ipcHandlers.get('detachedTerminal:closeWindow')?.(
      { sender: { id: 999 } },
      { worktreeId: 'wt-1', tabId: 'tab-1' }
    )

    expect(window.closed).toBe(false)
  })

  it('closing the origin tab closes the detached terminal window', async () => {
    const { openDetachedTerminalWindow, registerDetachedTerminalHandlers } =
      await importCoordinator()
    registerDetachedTerminalHandlers()
    await allowMainSenderToOpenDetachedPty()
    const window = openDetachedTerminalWindow({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      snapshot: baseSnapshot()
    }) as never as InstanceType<typeof mocks.FakeBrowserWindow>

    await mocks.ipcHandlers.get('detachedTerminal:closeWindow')?.(
      { sender: { id: 1 } },
      { worktreeId: 'wt-1', tabId: 'tab-1' }
    )

    expect(window.closed).toBe(true)
  })

  it('open -> rendererPtyReady -> main open again focuses existing', async () => {
    const { registerDetachedTerminalHandlers } = await importCoordinator()
    const { detachedWindowRegistry } = await import('./detached-window-registry')
    const { paneOwnershipRegistry } = await import('./pane-ownership-registry')
    registerDetachedTerminalHandlers()
    await allowMainSenderToOpenDetachedPty()

    // 1. Initial open from main window
    const openResult1 = await mocks.ipcHandlers.get('detachedTerminal:openWindow')?.(
      { sender: { id: 1, isDestroyed: () => false } },
      { worktreeId: 'wt-1', tabId: 'tab-1', snapshot: baseSnapshot() }
    )
    expect(openResult1).toEqual({ ok: true })

    const windowInstance = detachedWindowRegistry.getDetachedTerminalWindow({
      worktreeId: 'wt-1',
      tabId: 'tab-1'
    }) as never as InstanceType<typeof mocks.FakeBrowserWindow>
    expect(windowInstance).toBeDefined()
    expect(windowInstance.focused).toBe(false)

    // 2. Set the detached window webContents as the owner (simulating rendererPtyReady)
    paneOwnershipRegistry.registerTabPaneOwners({
      webContentsId: windowInstance.webContents.id,
      ptyIds: ['pty-1'],
      worktreeId: 'wt-1',
      tabId: 'tab-1'
    })

    // 3. Main open again (sender.id = 1) focuses existing window
    const openResult2 = await mocks.ipcHandlers.get('detachedTerminal:openWindow')?.(
      { sender: { id: 1, isDestroyed: () => false } },
      { worktreeId: 'wt-1', tabId: 'tab-1', snapshot: baseSnapshot() }
    )
    expect(openResult2).toEqual({ ok: true })
    expect(windowInstance.focused).toBe(true)
  })

  it('unrelated renderer cannot focus an already open detached window', async () => {
    const { registerDetachedTerminalHandlers } = await importCoordinator()
    const { detachedWindowRegistry } = await import('./detached-window-registry')
    registerDetachedTerminalHandlers()
    await allowMainSenderToOpenDetachedPty()

    // 1. Initial open from main window
    const openResult1 = await mocks.ipcHandlers.get('detachedTerminal:openWindow')?.(
      { sender: { id: 1, isDestroyed: () => false } },
      { worktreeId: 'wt-1', tabId: 'tab-1', snapshot: baseSnapshot() }
    )
    expect(openResult1).toEqual({ ok: true })

    const windowInstance = detachedWindowRegistry.getDetachedTerminalWindow({
      worktreeId: 'wt-1',
      tabId: 'tab-1'
    }) as never as InstanceType<typeof mocks.FakeBrowserWindow>
    expect(windowInstance).toBeDefined()
    expect(windowInstance.focused).toBe(false)

    // 2. Open request from unrelated sender (sender.id = 999) fails
    const openResult2 = await mocks.ipcHandlers.get('detachedTerminal:openWindow')?.(
      { sender: { id: 999, isDestroyed: () => false } },
      { worktreeId: 'wt-1', tabId: 'tab-1', snapshot: baseSnapshot() }
    )
    expect(openResult2).toEqual({ ok: false, error: 'detached_terminal_tab_unavailable' })
    expect(windowInstance.focused).toBe(false)
  })
})
