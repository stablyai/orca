import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ipc } = vi.hoisted((): { ipc: { current: EventEmitter | null } } => ({
  ipc: { current: null }
}))
vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      ipc.current!.on(channel, listener),
    removeListener: (channel: string, listener: (...args: unknown[]) => void) =>
      ipc.current!.removeListener(channel, listener)
  }
}))
vi.mock('./preload-runtime-support', () => ({ browserFindSubscriptions: { subscribe: vi.fn() } }))
import { uiTabAndBrowserCommandsApi } from './api/ui-bridge-tab-and-browser-commands'

describe('browser guest interaction subscription', () => {
  beforeEach(() => {
    ipc.current = new EventEmitter()
  })
  it('admits only a nonempty page ID and unsubscribes exactly its listener', () => {
    const received = vi.fn()
    const unsubscribe = uiTabAndBrowserCommandsApi.onBrowserGuestInteraction(received)
    for (const payload of [undefined, null, {}, [], 12, '']) {
      ipc.current!.emit('ui:browserGuestInteraction', {}, payload)
    }
    expect(received).not.toHaveBeenCalled()
    ipc.current!.emit('ui:browserGuestInteraction', {}, 'page-a')
    expect(received.mock.calls).toEqual([['page-a']])
    unsubscribe()
    ipc.current!.emit('ui:browserGuestInteraction', {}, 'page-b')
    expect(received).toHaveBeenCalledTimes(1)
    expect(ipc.current!.listenerCount('ui:browserGuestInteraction')).toBe(0)
  })
})
