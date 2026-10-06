import { afterEach, describe, expect, it, vi } from 'vitest'
import { uiTerminalAndSessionTabsApi } from './ui-bridge-terminal-and-session-tabs'

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  ipcMainOn: vi.fn(),
  ipcMainRemoveListener: vi.fn()
}))

vi.mock('electron', () => ({
  ipcRenderer: mocks
}))

describe('session tab props preload IPC contract', () => {
  afterEach(() => vi.clearAllMocks())

  it('listens on the renderer request channel and removes that listener', () => {
    const callback = vi.fn()
    const unsubscribe = uiTerminalAndSessionTabsApi.onSetSessionTabProps(callback)
    const listener = mocks.on.mock.calls[0]?.[1]

    expect(mocks.on).toHaveBeenCalledWith('ui:sessionTabPropsRequest', expect.any(Function))
    listener?.({}, { requestId: 'req-1', worktreeId: 'wt-1', tabId: 'tab-1', viewMode: 'chat' })
    expect(callback).toHaveBeenCalledWith({
      requestId: 'req-1',
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      viewMode: 'chat'
    })

    unsubscribe()
    expect(mocks.removeListener).toHaveBeenCalledWith('ui:sessionTabPropsRequest', listener)
  })

  it('sends the response on the relay response channel', () => {
    uiTerminalAndSessionTabsApi.respondSessionTabProps({ requestId: 'req-1' })
    expect(mocks.send).toHaveBeenCalledWith('ui:sessionTabPropsResponse', { requestId: 'req-1' })
  })
})
