import { EventEmitter } from 'node:events'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainEvent } from 'electron'

import {
  NATIVE_CHAT_VISUAL_GUEST_THEME_PUBLISH as PUBLISH,
  NATIVE_CHAT_VISUAL_GUEST_THEME_READ as READ
} from '../../shared/native-chat/native-chat-visual-shell'

const { ipc, classify, display, profileForSession, sshProfileForSession } = vi.hoisted(() => ({
  ipc: { on: vi.fn(), removeListener: vi.fn() },
  classify: vi.fn(() => true),
  profileForSession: vi.fn((): string | null => 'default'),
  sshProfileForSession: vi.fn((): string | null => null),
  display: {
    onGuestDocumentStart: vi.fn(),
    setGuestColorSchemeFallback: vi.fn(),
    onGuestRetired: vi.fn(),
    onMainFrameNavigationCommitted: vi.fn()
  }
}))
vi.mock('electron', () => ({ ipcMain: ipc }))
vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/profile'
}))
vi.mock('../native-chat/conversation-files/native-chat-scratch-folder', () => ({
  nativeChatScratchRootFor: () => '/profile/chat-scratch'
}))
vi.mock('../native-chat/conversation-files/native-chat-visual-guest-location', () => ({
  isNativeChatVisualGuestLocation: classify
}))
vi.mock('../browser/site-settings/display/browser-site-display-controller', () => ({
  browserSiteDisplayController: display
}))
vi.mock('../browser/sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: { profileIdForSession: profileForSession }
}))
vi.mock('../browser/routing/local-host-partitions/local-ssh-browser-partitions', () => ({
  localSshBrowserProfileIdForSession: sshProfileForSession
}))
import { installNativeChatVisualGuestTheme } from './native-chat-visual-guest-theme'

await vi.importActual('../browser/site-settings/display/browser-site-display-controller')

function contents(id: number, hostWebContents: EventEmitter | null = null) {
  return Object.assign(new EventEmitter(), {
    id,
    mainFrame: { url: 'file:///scratch/mock.html' },
    session: {},
    hostWebContents,
    getType: () => 'webview',
    isDestroyed: () => false,
    send: vi.fn()
  })
}
function setup() {
  const host = contents(1)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture implements only the Electron members the installer uses.
  installNativeChatVisualGuestTheme({ webContents: host } as unknown as BrowserWindow)
  const guest = contents(2)
  guest.hostWebContents = host
  const handler = (channel: string) => ipc.on.mock.calls.findLast(([name]) => name === channel)![1]
  const event = (sender = guest, senderFrame = sender.mainFrame, onReply = () => {}) => {
    let replied = false
    let reply: unknown
    const fixture = { sender, senderFrame }
    Object.defineProperty(fixture, 'returnValue', {
      get: () => reply,
      set: (value: unknown) => {
        // Electron consumes the reply channel on its first returnValue assignment.
        if (!replied) {
          replied = true
          reply = value
          onReply()
        }
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture models the consumed Electron event fields and first-reply semantics.
    return fixture as unknown as IpcMainEvent
  }
  return { host, guest, event, publish: handler(PUBLISH), read: handler(READ) }
}
const dark = { colorScheme: 'dark', tokens: { '--background': '#111' } }
beforeEach(() => {
  vi.resetAllMocks()
  classify.mockReturnValue(true)
  profileForSession.mockReturnValue('default')
})

describe('visual guest theme handoff', () => {
  it('publishes only from the host main frame and reads only owned visual main frames', () => {
    const { host, guest, event, publish, read } = setup()
    publish(event(), dark)
    const empty = event()
    read(empty)
    expect(empty.returnValue).toBeNull()
    publish(event(host), dark)
    const accepted = event()
    read(accepted)
    expect(accepted.returnValue).toMatchObject({
      colorScheme: 'dark',
      css: expect.stringContaining('--background:#111')
    })
    const subframe = event(guest, { url: guest.mainFrame.url })
    read(subframe)
    expect(subframe.returnValue).toBeNull()
    classify.mockReturnValue(false)
    const ordinary = event()
    read(ordinary)
    expect(ordinary.returnValue).toBeNull()
  })
})
