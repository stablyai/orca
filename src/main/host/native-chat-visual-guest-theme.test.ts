import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import {
  NATIVE_CHAT_VISUAL_GUEST_THEME_PUBLISH as PUBLISH,
  NATIVE_CHAT_VISUAL_GUEST_THEME_READ as READ,
  NATIVE_CHAT_VISUAL_GUEST_THEME_UPDATE as UPDATE
} from '../../shared/native-chat/native-chat-visual-shell'

const { ipc, classify, display } = vi.hoisted(() => ({
  ipc: { on: vi.fn(), removeListener: vi.fn() },
  classify: vi.fn(() => true),
  display: {
    setGuestColorSchemeFallback: vi.fn(),
    onGuestRetired: vi.fn(),
    onMainFrameNavigationCommitted: vi.fn()
  }
}))
vi.mock('electron', () => ({ ipcMain: ipc }))
vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/profile'
}))
vi.mock('../native-chat/native-chat-scratch-folder', () => ({
  nativeChatScratchRootFor: () => '/profile/chat-scratch'
}))
vi.mock('../native-chat/native-chat-visual-guest-location', () => ({
  isNativeChatVisualGuestLocation: classify
}))
vi.mock('../browser/site-settings/browser-site-display-controller', () => ({
  browserSiteDisplayController: display
}))
import { installNativeChatVisualGuestTheme } from './native-chat-visual-guest-theme'

function contents(id: number, hostWebContents: EventEmitter | null = null) {
  return Object.assign(new EventEmitter(), {
    id,
    mainFrame: { url: 'file:///scratch/mock.html' },
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
  const event = (sender = guest, senderFrame = sender.mainFrame) => {
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
  vi.clearAllMocks()
  classify.mockReturnValue(true)
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

  it('updates once per theme, releases navigating/destroyed guests and removes listeners with host', () => {
    const { host, guest, event, publish, read } = setup()
    publish(event(host), dark)
    read(event())
    read(event())
    publish(event(host), dark)
    expect(guest.send).not.toHaveBeenCalled()
    const light = { ...dark, colorScheme: 'light' }
    publish(event(host), light)
    expect(guest.send).toHaveBeenCalledExactlyOnceWith(
      UPDATE,
      expect.objectContaining({ colorScheme: 'light' })
    )
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    publish(event(host), dark)
    expect(guest.send).toHaveBeenCalledTimes(2)
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    publish(event(host), light)
    expect(guest.send).toHaveBeenCalledTimes(3)
    guest.emit('did-navigate', {}, guest.mainFrame.url)
    publish(event(host), dark)
    expect(guest.send).toHaveBeenCalledTimes(4)
    classify.mockReturnValue(false)
    guest.emit('did-navigate', {}, 'file:///workspace/ordinary.html')
    publish(event(host), light)
    expect(guest.send).toHaveBeenCalledTimes(4)
    classify.mockReturnValue(true)
    read(event())
    guest.emit('destroyed')
    publish(event(host), dark)
    expect(guest.send).toHaveBeenCalledTimes(4)
    host.emit('destroyed')
    expect(ipc.removeListener).toHaveBeenCalledTimes(2)
  })

  it.each([10, 100])(
    'bounds theme broadcasts to one operation per live guest at population %s',
    (population) => {
      const { host, event, publish, read } = setup()
      publish(event(host), dark)
      const guests = Array.from({ length: population }, (_, index) => contents(index + 10, host))
      for (const guest of guests) {
        read(event(guest))
        read(event(guest))
        expect(guest.listenerCount('did-navigate')).toBe(1)
        expect(guest.listenerCount('destroyed')).toBe(1)
      }
      display.setGuestColorSchemeFallback.mockClear()
      publish(event(host), { ...dark, colorScheme: 'light' })
      expect(display.setGuestColorSchemeFallback).toHaveBeenCalledTimes(population)
      expect(guests.reduce((sum, guest) => sum + guest.send.mock.calls.length, 0)).toBe(population)
      for (const guest of guests) {
        guest.emit('destroyed')
      }
      publish(event(host), dark)
      expect(guests.reduce((sum, guest) => sum + guest.send.mock.calls.length, 0)).toBe(population)
    }
  )

  it('does not overwrite another window’s synchronous answer', () => {
    const first = setup()
    const second = setup()
    first.publish(first.event(first.host), dark)
    const request = first.event()
    first.read(request)
    second.read(request)
    expect(request.returnValue).toMatchObject({ colorScheme: 'dark' })
  })
})
