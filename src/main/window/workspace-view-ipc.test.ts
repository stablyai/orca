import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  retained: new Set<number>(),
  displays: [
    { id: 1, scaleFactor: 1, workArea: { x: 0, y: 0, width: 500, height: 500 } },
    { id: 2, scaleFactor: 2, workArea: { x: -700, y: 0, width: 600, height: 700 } }
  ]
}))
vi.mock('electron', () => ({
  screen: { getAllDisplays: () => mocks.displays, getDisplayMatching: () => mocks.displays[1] },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('./workspace-window-native-bridge', () => ({
  authorizeWorkspaceWindowEvent: (event: { sender: { owner: unknown } }) => event.sender.owner,
  isRetainedWorkspacePrimary: (window: { id: number }) => mocks.retained.has(window.id)
}))
import { registerWorkspaceViewIpc } from './workspace-view-ipc'

function createWindow(id: number) {
  const events = new EventEmitter()
  const contents = new EventEmitter()
  const operations: string[] = []
  const window = Object.assign(events, {
    id,
    isDestroyed: () => false,
    isMinimized: vi.fn(() => false),
    isVisible: () => true,
    isMaximized: () => false,
    isFullScreen: () => false,
    getBounds: () => ({ x: 50, y: 50, width: 450, height: 450 }),
    setBounds: vi.fn(),
    getTitle: () => `Window ${id}`,
    getContentBounds: () => ({ x: (id - 1) * 600, y: 0, width: 500, height: 500 }),
    webContents: Object.assign(contents, {
      id: id * 10,
      getZoomFactor: vi.fn(() => 1),
      mainFrame: {},
      owner: undefined as unknown,
      send: vi.fn((_channel: string, requestId: string, operation: string) => {
        operations.push(operation)
        queueMicrotask(() => {
          void invoke('reply', window, requestId, { ok: true, value: true })
        })
      })
    })
  })
  window.webContents.owner = window
  return { window, operations }
}
function invoke(
  channel: string,
  window: ReturnType<typeof createWindow>['window'],
  ...args: unknown[]
) {
  return mocks.handlers.get(`workspaceViews:${channel}`)!(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    ...args
  )
}
beforeEach(() => {
  mocks.handlers.clear()
  mocks.retained.clear()
})

it('moves the invoking window and gathers registered windows onto its monitor', async () => {
  const primary = createWindow(1)
  const secondary = createWindow(2)
  registerWorkspaceViewIpc(() => primary.window as never)
  invoke('ready', primary.window)
  invoke('ready', secondary.window)
  expect(mocks.handlers.has('workspaceViews:moveToMonitor')).toBe(true)
  expect(await invoke('moveToMonitor', secondary.window, 2)).toBe(true)
  expect(secondary.window.setBounds).toHaveBeenCalledWith({
    x: -550,
    y: 50,
    width: 450,
    height: 450
  })
  expect(primary.window.setBounds).not.toHaveBeenCalled()
  expect(await invoke('moveToMonitor', secondary.window, 99)).toBe(false)
  await invoke('bringWindowsToMonitor', secondary.window)
  expect(primary.window.setBounds).toHaveBeenCalledWith(expect.objectContaining({ x: -550 }))
})

it('tiles registered windows on the invoking monitor without focusing them', async () => {
  const primary = createWindow(1)
  const secondary = createWindow(2)
  registerWorkspaceViewIpc(() => primary.window as never)
  invoke('ready', primary.window)
  invoke('ready', secondary.window)

  expect(await invoke('tileWindowsOnMonitor', secondary.window)).toBe(2)
  expect(primary.window.setBounds).toHaveBeenCalledWith({
    x: -688,
    y: 12,
    width: 282,
    height: 676
  })
  expect(secondary.window.setBounds).toHaveBeenCalledWith({
    x: -394,
    y: 12,
    width: 282,
    height: 676
  })
  expect(primary.window).not.toHaveProperty('show')
  expect(primary.window).not.toHaveProperty('focus')
})

it('distributes registered windows across all monitors', async () => {
  const primary = createWindow(1)
  const secondary = createWindow(2)
  registerWorkspaceViewIpc(() => primary.window as never)
  invoke('ready', primary.window)
  invoke('ready', secondary.window)

  expect(await invoke('distributeWindowsAcrossMonitors', secondary.window)).toBe(2)
  expect(primary.window.setBounds).toHaveBeenCalledWith({
    x: 12,
    y: 12,
    width: 476,
    height: 476
  })
  expect(secondary.window.setBounds).toHaveBeenCalledWith({
    x: -688,
    y: 12,
    width: 576,
    height: 676
  })
})

it('discovers presentations and fences Visit and Open against renderer reloads', async () => {
  const source = createWindow(1)
  const destination = createWindow(2)
  registerWorkspaceViewIpc(() => source.window as never)
  invoke('ready', source.window)
  invoke('ready', destination.window)
  expect(mocks.handlers.has('workspaceViews:discover')).toBe(true)
  destination.window.webContents.send.mockImplementation((_channel, id, operation) => {
    queueMicrotask(() => {
      void invoke('reply', destination.window, id, {
        ok: true,
        value: operation === 'discover' ? [{ paneId: 'pane', view: { id: 'editor' } }] : true
      })
    })
  })
  const placements = (await invoke('discover', source.window)) as {
    windowId: number
    epoch: number
  }[]
  const placement = placements.find((entry) => entry.windowId === 2)!
  expect(placement).toMatchObject({ windowId: 2, epoch: 0 })
  const target = { ...placement, paneId: 'pane', viewId: 'editor' }
  expect(await invoke('visit', source.window, target)).toBe(true)
  destination.window.webContents.emit('did-start-navigation', {}, '', false, true)
  invoke('ready', destination.window)
  expect(await invoke('visit', source.window, target)).toBe(false)
  expect(await invoke('open', source.window, target, { paneId: 'here', zone: 'center' })).toBe(
    false
  )
})

it('Open pulls through the authorized capture/import bridge without removing source', async () => {
  const source = createWindow(1)
  const destination = createWindow(2)
  registerWorkspaceViewIpc(() => source.window as never)
  invoke('ready', source.window)
  invoke('ready', destination.window)
  expect(mocks.handlers.has('workspaceViews:open')).toBe(true)
  expect(
    await invoke(
      'open',
      destination.window,
      {
        windowId: 1,
        epoch: 0,
        paneId: 'source',
        viewId: 'view'
      },
      { paneId: 'destination', zone: 'right' }
    )
  ).toBe(true)
  expect(source.operations).toContain('capture')
  expect(source.operations).not.toContain('remove')
  expect(destination.operations).toContain('import')
})

it('undoing a successful move restores source before reversing destination presentation', async () => {
  const source = createWindow(1)
  const destination = createWindow(2)
  registerWorkspaceViewIpc(() => source.window as never)
  invoke('ready', source.window)
  invoke('ready', destination.window)
  await invoke('transfer', source.window, { destinationId: 2, mode: 'tabs', viewIds: ['view'] })
  const id = destination.window.webContents.send.mock.calls.find((call) => call[2] === 'import')![1]
  const imports = destination.window.webContents.send.mock.calls as unknown as [
    string,
    string,
    string,
    { id: string }
  ][]
  const transactionId = imports.find((call) => call[2] === 'import')![3].id
  expect(id).toBeTruthy()
  expect(mocks.handlers.has('workspaceViews:undoTransfer')).toBe(true)
  expect(await invoke('undoTransfer', destination.window, transactionId)).toBe(true)
  expect(source.operations).toContain('undo-transfer')
  expect(destination.operations).toContain('undo-transfer')
})

it('preflights both undo participants and retries an acknowledged source after destination failure', async () => {
  const source = createWindow(1)
  const destination = createWindow(2)
  registerWorkspaceViewIpc(() => source.window as never)
  invoke('ready', source.window)
  invoke('ready', destination.window)
  await invoke('transfer', source.window, { destinationId: 2, mode: 'tabs' })
  const calls = destination.window.webContents.send.mock.calls as unknown as [
    string,
    string,
    string,
    { id: string }
  ][]
  const id = calls.find((call) => call[2] === 'import')![3].id
  const send = destination.window.webContents.send.getMockImplementation()!
  let rejected = 'prepare-undo-transfer'
  destination.window.webContents.send.mockImplementation((channel, requestId, operation) => {
    if (operation === rejected) {
      void invoke('reply', destination.window, requestId, { ok: true, value: false })
    } else {
      send(channel, requestId, operation)
    }
  })
  expect(await invoke('undoTransfer', destination.window, id)).toBe(false)
  expect(source.operations).not.toContain('undo-transfer')
  rejected = 'undo-transfer'
  expect(await invoke('undoTransfer', destination.window, id)).toBe(false)
  expect(source.operations).toContain('undo-transfer')
  rejected = ''
  expect(await invoke('undoTransfer', destination.window, id)).toBe(true)
})

it('does not return a new destination until its renderer registers readiness', async () => {
  const source = createWindow(1)
  const destination = createWindow(2)
  const create = vi.fn(() => destination.window as never)
  registerWorkspaceViewIpc(() => source.window as never, create)
  const result = Promise.resolve(invoke('createWindow', source.window))
  const settled = vi.fn()
  void result.then(settled)
  await Promise.resolve()
  expect(create).toHaveBeenCalledOnce()
  expect(settled).not.toHaveBeenCalled()
  invoke('ready', destination.window)
  expect(await result).toBe(2)
})

it('resolves a cross-window drag against the destination renderer and forwards the target transactionally', async () => {
  const source = createWindow(1)
  const destination = createWindow(2)
  registerWorkspaceViewIpc(() => source.window as never)
  invoke('ready', source.window)
  invoke('ready', destination.window)
  const target = { paneId: 'destination-pane', zone: 'right' }
  destination.window.webContents.send.mockImplementation((_channel, id, operation) => {
    queueMicrotask(() => {
      void invoke('reply', destination.window, id, {
        ok: true,
        value: operation === 'drop-target' ? { target, label: 'Split right of Beta' } : true
      })
    })
  })
  expect(await invoke('locateDrop', source.window, { x: 700, y: 250 })).toEqual({
    destinationId: 2,
    title: 'Window 2',
    target,
    label: 'Split right of Beta'
  })
  expect(destination.window.webContents.send).toHaveBeenCalledWith(
    'workspaceViews:request',
    expect.any(String),
    'drop-target',
    { x: 100, y: 250 }
  )
  expect(
    await invoke('transfer', source.window, {
      destinationId: 2,
      mode: 'tabs',
      target,
      viewIds: ['view']
    })
  ).toBe(true)
  expect(destination.window.webContents.send).toHaveBeenCalledWith(
    'workspaceViews:request',
    expect.any(String),
    'import',
    expect.objectContaining({ target })
  )
  expect(source.operations).toContain('remove')
})

it('ignores minimized destinations and prefers the last focused overlapping destination', async () => {
  const source = createWindow(1)
  const destination = createWindow(2)
  const overlapping = createWindow(3)
  overlapping.window.getContentBounds = destination.window.getContentBounds
  registerWorkspaceViewIpc(() => source.window as never)
  invoke('ready', source.window)
  invoke('ready', destination.window)
  invoke('ready', overlapping.window)
  destination.window.emit('focus')
  expect(await invoke('locateDrop', source.window, { x: 700, y: 250 })).toMatchObject({
    destinationId: 2
  })
  destination.window.isMinimized.mockReturnValue(true)
  expect(await invoke('locateDrop', source.window, { x: 700, y: 250 })).toMatchObject({
    destinationId: 3
  })
  overlapping.window.isMinimized.mockReturnValue(true)
  expect(await invoke('locateDrop', source.window, { x: 700, y: 250 })).toBeNull()
})

it('converts between unequal renderer zoom factors when locating a native drop', async () => {
  const source = createWindow(1)
  const destination = createWindow(2)
  source.window.webContents.getZoomFactor.mockReturnValue(1.5)
  destination.window.webContents.getZoomFactor.mockReturnValue(2)
  source.window.getContentBounds = () => ({ x: -900, y: -500, width: 500, height: 500 })
  destination.window.getContentBounds = () => ({ x: -300, y: -500, width: 500, height: 500 })
  registerWorkspaceViewIpc(() => source.window as never)
  invoke('ready', destination.window)
  expect(await invoke('locateDrop', source.window, { x: 500, y: 200 })).toMatchObject({
    destinationId: 2
  })
  expect(destination.window.webContents.send).toHaveBeenCalledWith(
    'workspaceViews:request',
    expect.any(String),
    'drop-target',
    { x: 75, y: 150 }
  )
})

it('restores source when destination renderer crashes during source removal', async () => {
  const source = createWindow(1)
  const destination = createWindow(2)
  registerWorkspaceViewIpc(() => source.window as never)
  invoke('ready', source.window)
  invoke('ready', destination.window)
  const send = source.window.webContents.send.getMockImplementation()!
  source.window.webContents.send.mockImplementation((channel, id, operation) => {
    if (operation === 'remove') {
      destination.window.webContents.emit('render-process-gone')
    }
    send(channel, id, operation)
  })
  expect(await invoke('transfer', source.window, { destinationId: 2, mode: 'tabs' })).toBe(false)
  expect(source.operations).toContain('restore')
})

it('excludes a presentation-closed primary while retaining its execution renderer', async () => {
  const source = createWindow(1)
  const destination = createWindow(2)
  registerWorkspaceViewIpc(() => source.window as never)
  invoke('ready', source.window)
  invoke('ready', destination.window)
  await invoke('register', source.window, [{ key: 'terminal', viewId: 'view' }])
  mocks.retained.add(1)
  source.window.emit('workspace-presentation-retained')
  await Promise.resolve()
  expect(invoke('list', destination.window)).toEqual([{ id: 2, title: 'Window 2' }])
  expect(await invoke('transfer', destination.window, { destinationId: 1, mode: 'tabs' })).toBe(
    false
  )
  expect(source.window.isDestroyed()).toBe(false)
  mocks.retained.delete(1)
  source.window.emit('show')
  expect(await invoke('claim', source.window, 'terminal', 'view')).toBe(true)
})

it('automatically returns control to the sole secondary after retention and reload', async () => {
  const primary = createWindow(1)
  const secondary = createWindow(2)
  registerWorkspaceViewIpc(() => primary.window as never)
  invoke('ready', primary.window)
  invoke('ready', secondary.window)
  await invoke('register', primary.window, [{ key: 'browser', viewId: 'primary' }])
  await invoke('register', secondary.window, [{ key: 'browser', viewId: 'secondary' }])
  await invoke('claim', secondary.window, 'browser', 'secondary')
  mocks.retained.add(1)
  primary.window.emit('workspace-presentation-retained')
  secondary.window.webContents.emit('did-start-navigation', {}, '', false, true)
  invoke('ready', secondary.window)
  await invoke('register', secondary.window, [{ key: 'browser', viewId: 'restored' }])
  expect(secondary.window.webContents.send).toHaveBeenLastCalledWith(
    'workspaceViews:request',
    expect.any(String),
    'controllers',
    { browser: { windowId: 2, viewId: 'restored' } }
  )
  expect(await invoke('claim', primary.window, 'browser', 'primary')).toBe(false)
  expect(primary.window.isDestroyed()).toBe(false)
})
