import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  authorize: vi.fn(),
  findClientPage: vi.fn(),
  disconnected: false,
  generation: 0,
  environment: { id: 'configured', runtimeId: 'remote', pairingRevision: 42 },
  guest: {
    isDestroyed: () => false,
    debugger: {
      isAttached: () => true,
      sendCommand: vi.fn(async () => ({})),
      on: vi.fn(),
      removeListener: vi.fn()
    }
  },
  context: { browserPageId: 'page', worktreeId: 'folder' }
}))
vi.mock('electron', () => ({
  app: { getPath: () => 'user-data' },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler)
  },
  webContents: { fromId: () => mocks.guest }
}))
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: () => mocks.environment,
  listEnvironments: () => [mocks.environment]
}))
vi.mock('../ipc/runtime-environment-manual-disconnect', () => ({
  isRuntimeEnvironmentManuallyDisconnected: () => mocks.disconnected
}))
vi.mock('../ipc/runtime-environment-transport-generation', () => ({
  getRuntimeEnvironmentTransportGeneration: () => mocks.generation
}))
vi.mock('../browser/browser-manager', () => ({
  browserManager: {
    getGuestWebContentsId: () => 42,
    getManagedBrowserGuestContext: () => mocks.context
  }
}))
vi.mock('../browser/paired-runtime-browser-client-host-runtime', () => ({
  findLocalClientHostedBrowserPage: mocks.findClientPage
}))
vi.mock('./workspace-window-native-bridge', () => ({
  authorizeWorkspaceWindowEvent: mocks.authorize
}))
import { registerWorkspaceWindowBrowserStream } from './workspace-window-browser-stream'

beforeEach(() => {
  mocks.handlers.clear()
  mocks.authorize.mockReset()
  mocks.findClientPage.mockReset()
  mocks.disconnected = false
  mocks.generation = 0
})

it('fences inherited browser input and capture by pairing revision and transport lifetime', async () => {
  mocks.findClientPage.mockReturnValue({ workspaceId: 'folder', state: 'active' })
  let options!: { signal: AbortSignal; emit: (value: unknown) => void }
  const runtime = {
    getRuntimeId: () => 'local',
    browserScreencast: vi.fn(async (_params, input) => {
      options = input
      await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve()))
    })
  }
  registerWorkspaceWindowBrowserStream(() => runtime as never)
  const event = {
    sender: Object.assign(new EventEmitter(), { id: 2, isDestroyed: () => false, send: vi.fn() })
  }
  const request = {
    environmentId: 'configured',
    runtimeId: 'remote',
    expectedEnvironmentPairingRevision: 41,
    params: { page: 'page', worktree: 'id:folder', x: 1, y: 2 }
  }
  const start = mocks.handlers.get('workspaceWindow:browserStream:start')!
  const input = mocks.handlers.get('workspaceWindow:browserInput')!
  await expect(input(event, { ...request, method: 'browser.mouseMove' })).rejects.toThrow(
    'runtime_environment_changed'
  )
  expect(() => start(event, 'stale', request)).toThrow('runtime_environment_changed')
  expect(runtime.browserScreencast).not.toHaveBeenCalled()
  request.expectedEnvironmentPairingRevision = 42
  expect(start(event, 'live', request)).toBe(true)
  mocks.generation += 1
  options.emit({ stale: true })
  expect(options.signal.aborted).toBe(true)
  expect(event.sender.send.mock.calls.some(([, value]) => value.kind === 'response')).toBe(false)
  mocks.disconnected = true
  await expect(input(event, { ...request, method: 'browser.mouseMove' })).rejects.toThrow(
    'runtime_manually_disconnected'
  )
})

it('keeps the local stream open until renderer navigation cancels it', async () => {
  let options!: { signal: AbortSignal; emit: (data: unknown) => void }
  const runtime = {
    getRuntimeId: () => 'local',
    browserScreencast: vi.fn(async (_params, input) => {
      options = input
      input.emit({ type: 'ready' })
      await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve()))
    })
  }
  registerWorkspaceWindowBrowserStream(() => runtime as never)
  const sender = Object.assign(new EventEmitter(), {
    id: 2,
    isDestroyed: () => false,
    send: vi.fn()
  })
  const event = { sender }
  const request = { runtimeId: 'local', params: { page: 'page', worktree: 'id:folder' } }
  expect(mocks.handlers.get('workspaceWindow:browserStream:start')!(event, 'one', request)).toBe(
    true
  )
  expect(mocks.authorize).toHaveBeenCalledWith(event)
  expect(sender.send).toHaveBeenCalledWith(
    'workspaceWindow:browserStream:event',
    expect.objectContaining({ kind: 'response' })
  )
  await Promise.resolve()
  expect(sender.listenerCount('destroyed')).toBe(1)
  expect(options.signal.aborted).toBe(false)
  sender.emit('did-start-navigation', {}, 'https://example.test', false, false)
  sender.emit('did-start-navigation', {}, 'https://example.test#hash', true, true)
  expect(options.signal.aborted).toBe(false)
  sender.emit('did-start-navigation', {}, 'https://example.test', false, true)
  expect(options.signal.aborted).toBe(true)
  await vi.waitFor(() => expect(sender.listenerCount('destroyed')).toBe(0))
})

it('rejects a different runtime or workspace even when the page ID matches a local guest', () => {
  const runtime = { getRuntimeId: () => 'local', browserScreencast: vi.fn() }
  registerWorkspaceWindowBrowserStream(() => runtime as never)
  const start = mocks.handlers.get('workspaceWindow:browserStream:start')!
  expect(
    start({ sender: { id: 2 } }, 'one', {
      runtimeId: 'remote',
      params: { page: 'page', worktree: 'id:folder' }
    })
  ).toBe(false)
  expect(
    start({ sender: { id: 2 } }, 'two', {
      runtimeId: 'local',
      params: { page: 'page', worktree: 'id:other' }
    })
  ).toBe(false)
  expect(runtime.browserScreencast).not.toHaveBeenCalled()
  mocks.findClientPage.mockReturnValue({ workspaceId: 'folder', state: 'outcomeUnknown' })
  expect(
    start({ sender: { id: 2 } }, 'retired', {
      runtimeId: 'local',
      params: { page: 'page', worktree: 'id:folder' }
    })
  ).toBe(false)
})

it('dispatches pointer and keyboard input to the authorized existing guest', async () => {
  registerWorkspaceWindowBrowserStream(() => ({ getRuntimeId: () => 'local' }) as never)
  const call = mocks.handlers.get('workspaceWindow:browserInput')!
  const event = { sender: { id: 2 } }
  const request = {
    runtimeId: 'local',
    method: 'browser.mouseMove',
    params: { page: 'page', worktree: 'id:folder', x: 50, y: 30 }
  }
  expect(await call(event, request)).toMatchObject({ ok: true })
  await call(event, { ...request, method: 'browser.mouseDown' })
  expect(mocks.guest.debugger.sendCommand).toHaveBeenCalledWith(
    'Input.dispatchMouseEvent',
    expect.objectContaining({ type: 'mousePressed', x: 50, y: 30 })
  )
  await call(event, request)
  expect(mocks.guest.debugger.sendCommand).toHaveBeenLastCalledWith(
    'Input.dispatchMouseEvent',
    expect.objectContaining({ type: 'mouseMoved', buttons: 1 })
  )
  await call(event, {
    ...request,
    method: 'browser.keypress',
    params: { ...request.params, key: '+' }
  })
  expect(mocks.guest.debugger.sendCommand).toHaveBeenCalledWith(
    'Input.dispatchKeyEvent',
    expect.objectContaining({ type: 'keyDown', text: '+' })
  )
  await call(event, {
    ...request,
    method: 'browser.keypress',
    params: { ...request.params, key: 'Control++' }
  })
  expect(mocks.guest.debugger.sendCommand).toHaveBeenCalledWith(
    'Input.dispatchKeyEvent',
    expect.objectContaining({ type: 'keyDown', key: '+', modifiers: 2 })
  )
  await call({ sender: { id: 3 } }, { ...request, params: { ...request.params, x: 100, y: 200 } })
  await call(event, { ...request, method: 'browser.mouseDown' })
  expect(mocks.guest.debugger.sendCommand).toHaveBeenLastCalledWith(
    'Input.dispatchMouseEvent',
    expect.objectContaining({ type: 'mousePressed', x: 50, y: 30 })
  )
  await call(event, {
    ...request,
    method: 'browser.keypress',
    params: { ...request.params, key: 'a' }
  })
  expect(mocks.guest.debugger.sendCommand).toHaveBeenCalledWith(
    'Input.dispatchKeyEvent',
    expect.objectContaining({ type: 'keyDown', text: 'a' })
  )
  mocks.guest.debugger.sendCommand.mockClear()
  expect(await call(event, { ...request, runtimeId: 'remote' })).toBeNull()
  expect(mocks.guest.debugger.sendCommand).not.toHaveBeenCalled()
})
