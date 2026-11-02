import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/downloads' },
  BrowserWindow: { fromWebContents: () => null },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: () => null }
}))
vi.mock('./popup-origin-bar-window', () => ({ openPopupWithOriginBar: vi.fn() }))

import { BrowserManager } from './browser-manager'
import { DestroyedGuestTestContents } from './browser-manager-destroyed-guest-test-fixture'

const manager = new BrowserManager()

/** Emits what Electron emits when the page asks to confirm leaving; true means the page leaves. */
function askToLeave(guest: DestroyedGuestTestContents): boolean {
  let leaves = false
  guest.emit('will-prevent-unload', { preventDefault: () => (leaves = true) })
  return leaves
}

afterEach(() => {
  manager.unregisterAll()
})

// Why: without an answer Electron keeps the page, so every link on it looked dead (#28732).
it('lets browsing and workspace-document pages leave when they ask to confirm', () => {
  const browsing = new DestroyedGuestTestContents(1)
  manager.attachGuestPolicies(browsing.asWebContents())
  const document = Object.assign(new DestroyedGuestTestContents(2), {
    setWebRTCIPHandlingPolicy: () => {}
  })
  manager.attachGuestPolicies(document.asWebContents(), null, {
    profile: 'workspace-doc',
    host: new DestroyedGuestTestContents(3).asWebContents()
  })

  expect(askToLeave(browsing)).toBe(true)
  expect(askToLeave(document)).toBe(true)
})
