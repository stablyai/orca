import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/downloads' },
  BrowserWindow: { fromWebContents: () => null },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: () => null }
}))
vi.mock('../../popups/presentation/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: vi.fn()
}))

import {
  DestroyedGuestTestContents,
  DestroyedGuestTestManager
} from './browser-manager-destroyed-guest-test-fixture'

describe('workspace document guest shortcuts', () => {
  it('forwards Ctrl+Tab from a focused document preview to its host window', () => {
    const manager = new DestroyedGuestTestManager()
    const guest = new DestroyedGuestTestContents(7)
    const send = vi.fn()
    const host = Object.assign(new DestroyedGuestTestContents(5001), { send })
    manager.attachGuestPolicies(guest.asWebContents(), null, {
      profile: 'workspace-doc',
      host: host.asWebContents()
    })

    const input = { shift: false, alt: false, meta: false, isAutoRepeat: false }
    guest.emit(
      'before-input-event',
      { preventDefault: vi.fn() },
      {
        ...input,
        type: 'keyDown',
        key: 'Tab',
        code: 'Tab',
        control: true
      }
    )
    guest.emit(
      'before-input-event',
      { preventDefault: vi.fn() },
      {
        ...input,
        type: 'keyUp',
        key: 'Control',
        code: 'ControlLeft',
        control: false
      }
    )

    expect(send.mock.calls).toEqual([
      ['ui:ctrlTabKeyDown', { shiftKey: false }],
      ['ui:ctrlTabKeyUp']
    ])
    guest.destroy()
  })
})
