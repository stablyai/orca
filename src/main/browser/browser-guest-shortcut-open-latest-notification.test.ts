import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  hasOpenableNotification,
  openLatestNotification,
  registerOpenableNotification
} from '../ipc/openable-notifications'
import {
  forwardGuestShortcutInput,
  type GuestShortcutInput
} from './browser-guest-shortcut-dispatch'

afterEach(() => {
  // Drain entries a test left behind so the module-level list starts empty.
  while (openLatestNotification()) {
    // keep opening
  }
})

function pressOpenLatest(isAutoRepeat: boolean): { claimed: boolean; prevented: boolean } {
  const isMac = process.platform === 'darwin'
  const preventDefault = vi.fn()
  const event: Electron.Event = { preventDefault, defaultPrevented: false }
  const input: GuestShortcutInput = {
    type: 'keyDown',
    code: 'Enter',
    key: 'Enter',
    meta: isMac,
    control: !isMac,
    alt: true,
    shift: false,
    isAutoRepeat
  }
  const claimed = forwardGuestShortcutInput(
    {
      browserTabId: 'tab-1',
      resolveRenderer: () => null,
      forwardBrowserPageZoom: vi.fn()
    },
    event,
    input
  )
  return { claimed, prevented: preventDefault.mock.calls.length > 0 }
}

describe('open latest notification from a focused browser guest', () => {
  it('opens once while the chord is held and keeps the repeats from the page', () => {
    const older = vi.fn()
    const newer = vi.fn()
    registerOpenableNotification(older)
    registerOpenableNotification(newer)

    expect(pressOpenLatest(false)).toEqual({ claimed: true, prevented: true })
    expect(pressOpenLatest(true)).toEqual({ claimed: true, prevented: true })
    expect(pressOpenLatest(true)).toEqual({ claimed: true, prevented: true })

    expect(newer).toHaveBeenCalledTimes(1)
    expect(older).not.toHaveBeenCalled()
    expect(hasOpenableNotification()).toBe(true)
  })

  it('leaves the chord and its repeats to the page when nothing is left to open', () => {
    expect(pressOpenLatest(false)).toEqual({ claimed: false, prevented: false })
    expect(pressOpenLatest(true)).toEqual({ claimed: false, prevented: false })
  })
})
