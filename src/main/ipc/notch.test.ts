import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTCH_SET_EXPANDED_CHANNEL } from '../../shared/notch/notch-snapshot'

/** Stands in for a webContents: the handlers only compare senders by identity. */
type FakeSender = { readonly name: string }

const { handlers, notchSender, appSender, setNotchExpanded } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: FakeSender }, value: unknown) => void>(),
  notchSender: { name: 'notch' },
  appSender: { name: 'app' },
  setNotchExpanded: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeAllListeners: (channel: string) => handlers.delete(channel),
    on: (channel: string, handler: (event: { sender: FakeSender }, value: unknown) => void) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('../notch/notch-window', () => ({
  isNotchRenderer: (sender: FakeSender) => sender === notchSender,
  setNotchExpanded,
  setNotchInteractive: vi.fn()
}))
vi.mock('./ui', () => ({
  getTrustedUIRendererWindow: () => ({ webContents: appSender })
}))

import { registerNotchHandlers } from './notch'

function sendSetExpanded(sender: FakeSender, value: unknown): void {
  handlers.get(NOTCH_SET_EXPANDED_CHANNEL)?.({ sender }, value)
}

describe('notch setExpanded IPC', () => {
  beforeEach(() => {
    setNotchExpanded.mockClear()
    registerNotchHandlers({
      getService: () => null,
      revealPane: vi.fn(),
      onRevealRendererReady: vi.fn()
    })
  })

  it('lets the notch renderer expand and collapse', () => {
    sendSetExpanded(notchSender, true)
    sendSetExpanded(notchSender, false)
    expect(setNotchExpanded.mock.calls).toEqual([[true], [false]])
  })

  it('lets the app window only collapse the panel', () => {
    sendSetExpanded(appSender, true)
    expect(setNotchExpanded.mock.calls).toEqual([[false]])
  })

  it('ignores any other sender', () => {
    sendSetExpanded({ name: 'other' }, false)
    expect(setNotchExpanded).not.toHaveBeenCalled()
  })
})
