// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

type IpcListener = (...args: unknown[]) => void

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, IpcListener>(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, listener: IpcListener) => {
      mocks.listeners.set(channel, listener)
    },
    removeListener: mocks.removeListener,
    send: vi.fn()
  }
}))

import { uiTabAndBrowserCommandsApi } from './api/ui-bridge-tab-and-browser-commands'

describe('browser page shortcut targeting bridge', () => {
  beforeEach(() => {
    mocks.listeners.clear()
    mocks.removeListener.mockClear()
  })

  it('preserves the source browser page through history and reload events', () => {
    const history = vi.fn()
    const reload = vi.fn()
    const hardReload = vi.fn()

    uiTabAndBrowserCommandsApi.onBrowserHistoryNavigate(history)
    uiTabAndBrowserCommandsApi.onReloadBrowserPage(reload)
    uiTabAndBrowserCommandsApi.onHardReloadBrowserPage(hardReload)

    mocks.listeners.get('ui:browserHistoryNavigate')?.(
      {},
      {
        browserPageId: 'page-b',
        direction: 'back'
      }
    )
    mocks.listeners.get('ui:reloadBrowserPage')?.({}, { browserPageId: 'page-b' })
    mocks.listeners.get('ui:hardReloadBrowserPage')?.({}, { browserPageId: 'page-b' })

    expect(history).toHaveBeenCalledWith({ browserPageId: 'page-b', direction: 'back' })
    expect(reload).toHaveBeenCalledWith({ browserPageId: 'page-b' })
    expect(hardReload).toHaveBeenCalledWith({ browserPageId: 'page-b' })
  })
})
