import { expect, it, vi } from 'vitest'
import { SESSION_TAB_METHODS } from '../runtime/rpc/methods/session-tabs'
import { ClientSessionTabSelectionStore } from '../runtime/client-session-tab-selection'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  status: vi.fn(),
  disconnected: false
}))
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ id: 'configured', pairingRevision: 42 })
}))
vi.mock('../ipc/runtime-environment-manual-disconnect', () => ({
  isRuntimeEnvironmentManuallyDisconnected: () => mocks.disconnected
}))
vi.mock('electron', () => ({
  app: { getPath: () => 'user-data' },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('./workspace-window-native-bridge', () => ({
  getWorkspaceWindowNavigationId: () => 'second',
  authorizeWorkspaceWindowEvent: (event: { authorized?: boolean; sender: unknown }) => {
    if (!event.authorized) {
      throw new Error('workspace_window_native_bridge_unauthorized')
    }
  }
}))
vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  getRuntimeEnvironmentStatus: mocks.status
}))

it('keeps sender, selector and pairing revision while refusing unsupported hosts and unauthenticated frames', async () => {
  const { registerWorkspaceWindowRuntimeHandler } =
    await import('./workspace-window-runtime-routing')
  const call = vi.fn(async () => ({ ok: true }))
  registerWorkspaceWindowRuntimeHandler('runtimeEnvironments:call', call)
  const handler = mocks.handlers.get('workspaceWindow:runtimeEnvironments:call')!
  const sender = { id: 42 }
  const event = { authorized: true, sender }
  const args = {
    selector: 'configured',
    method: 'session.tabs.activate',
    params: { worktree: 'id:project', tabId: 'tab', navigation: 'caller' },
    expectedEnvironmentPairingRevision: 42
  }
  mocks.status.mockResolvedValue({
    ok: true,
    result: { capabilities: ['session-tabs.window-navigation.v1'] }
  })
  await handler(event, args)
  expect(call).toHaveBeenCalledWith(event, {
    ...args,
    method: 'session.window.tabs.activate',
    params: { windowId: 'second', params: args.params }
  })
  call.mockClear()
  mocks.status.mockResolvedValue({ ok: true, result: { capabilities: [] } })
  await expect(handler(event, args)).rejects.toThrow('workspace_window_navigation_unsupported')
  expect(call).not.toHaveBeenCalled()
  await expect(handler({ sender }, args)).rejects.toThrow(
    'workspace_window_native_bridge_unauthorized'
  )
  mocks.status.mockClear()
  mocks.disconnected = true
  await expect(handler(event, args)).rejects.toThrow('runtime_manually_disconnected')
  expect(mocks.status).not.toHaveBeenCalled()
  mocks.disconnected = false
})

it('namespaces session reads by authenticated device and native window without changing device authority', async () => {
  const method = SESSION_TAB_METHODS.find((entry) => entry.name === 'session.window.tabs.list')
  expect(method).toBeDefined()
  const listMobileSessionTabs = vi.fn(async (_worktree: string, _owner?: string) => ({ tabs: [] }))
  const runtime = { listMobileSessionTabs }
  const context = { runtime, pairedDeviceId: 'desktop-device' }
  for (const windowId of ['first', 'second']) {
    const params = method!.params!.parse({ windowId, params: { worktree: 'id:same-project' } })
    await method!.handler(params, context as never, vi.fn())
  }
  const owners = listMobileSessionTabs.mock.calls.map((call) => call[1])
  expect(new Set(owners).size).toBe(2)
  expect(owners).not.toContain('desktop-device')
  expect(context.pairedDeviceId).toBe('desktop-device')
})

it('does not expose destructive close or shared layout mutations as window operations', () => {
  const names = SESSION_TAB_METHODS.map((method) => method.name)
  expect(names).not.toContain('session.window.tabs.close')
  expect(names).not.toContain('session.window.tabs.move')
  expect(names).not.toContain('session.window.tabs.updatePaneLayout')
})

it('revocation removes only the device and its window navigation records', () => {
  const store = new ClientSessionTabSelectionStore()
  const selection = {
    activeTabId: 'tab',
    activeGroupId: 'group',
    activeTabIdByGroupId: { group: 'tab' }
  }
  store.hydrate(
    Object.fromEntries(
      ['device', 'device:window:first', 'device:window:second', 'device-other:window:first'].map(
        (owner) => [owner, { worktree: selection }]
      )
    )
  )
  store.forgetClient('device')
  expect(Object.keys(store.serialize())).toEqual(['device-other:window:first'])
})

it('keeps unsubscribe sweeps inside the window on a shared transport', async () => {
  const registered: string[] = []
  const cleanupSubscriptionsByPrefix = vi.fn()
  const runtime = {
    listMobileSessionTabs: async () => ({ worktree: 'worktree', tabs: [] }),
    registerSubscriptionCleanup: (id: string) => registered.push(id),
    onMobileSessionTabsChanged: () => () => {},
    cleanupSubscription: vi.fn(),
    cleanupSubscriptionsByPrefix
  }
  const context = { runtime, pairedDeviceId: 'device', connectionId: 'shared', requestId: 'stream' }
  for (const windowId of ['first', 'second']) {
    const subscribe = SESSION_TAB_METHODS.find(
      (entry) => entry.name === 'session.window.tabs.subscribe'
    )!
    await subscribe.handler(
      subscribe.params!.parse({ windowId, params: { worktree: 'worktree' } }),
      context as never,
      vi.fn()
    )
  }
  const unsubscribe = SESSION_TAB_METHODS.find(
    (entry) => entry.name === 'session.window.tabs.unsubscribe'
  )!
  await unsubscribe.handler(
    unsubscribe.params!.parse({ windowId: 'second', params: { worktree: 'worktree' } }),
    context as never,
    vi.fn()
  )
  expect(registered[0]).not.toBe(registered[1])
  expect(
    cleanupSubscriptionsByPrefix.mock.calls.some(([prefix]) => registered[0]!.startsWith(prefix))
  ).toBe(false)
  expect(
    cleanupSubscriptionsByPrefix.mock.calls.some(([prefix]) => registered[1]!.startsWith(prefix))
  ).toBe(true)
})
