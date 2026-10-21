import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginPanelMessage } from '../../shared/plugins/plugin-panel-bridge'

const ipc = vi.hoisted(() => ({
  on: vi.fn(),
  send: vi.fn(),
  removeListener: vi.fn(),
  invoke: vi.fn()
}))
vi.mock('electron', () => ({ ipcRenderer: ipc }))
import { pluginsApi } from './plugins-bridge'

beforeEach(() => vi.clearAllMocks())

describe('plugin panel message preload', () => {
  it('installs the listener before subscribing and filters sessions and leases', () => {
    const callback = vi.fn()
    const close = pluginsApi.onPanelMessage('token', callback)
    expect(ipc.on.mock.invocationCallOrder[0]).toBeLessThan(ipc.send.mock.invocationCallOrder[0]!)
    const listener = ipc.on.mock.calls[0]![1]
    const subscription = ipc.send.mock.calls[0]![1]
    const message: PluginPanelMessage = { type: 'orca-panel-message', data: null }
    listener({}, { ...subscription, message, sessionToken: 'other' })
    listener({}, { ...subscription, message, subscriptionId: 'other' })
    expect(callback).not.toHaveBeenCalled()
    listener({}, { ...subscription, message })
    expect(callback).toHaveBeenCalledExactlyOnceWith(message)
    close()
    expect(ipc.removeListener).toHaveBeenCalledWith('plugins:panelMessage', listener)
    expect(ipc.send).toHaveBeenLastCalledWith('plugins:panelMessageSubscription', {
      ...subscription,
      enabled: false
    })
  })
})
