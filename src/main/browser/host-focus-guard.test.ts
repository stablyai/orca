import { describe, it, expect, vi, beforeEach } from 'vitest'
import { webContents } from 'electron'
import { captureHostFocus, restoreHostFocus } from './host-focus-guard'

vi.mock('electron', () => ({
  webContents: { getFocusedWebContents: vi.fn() }
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asWebContents = (value: unknown): any => value

function makeContents(id: number, destroyed = false) {
  return {
    id,
    isDestroyed: () => destroyed,
    focus: vi.fn()
  }
}

const focusedMock = vi.mocked(webContents.getFocusedWebContents)

// Why: a synthetic mousePressed into an automation guest hands native focus to
// that guest, pulling the caret out of whatever pane the user was typing in
// (#8139). These tests pin the capture/restore contract that hands it back.
describe('host focus guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('captureHostFocus', () => {
    it('returns the focused host contents when a different view owns focus', () => {
      const host = makeContents(1)
      focusedMock.mockReturnValue(asWebContents(host))

      expect(captureHostFocus(42)).toBe(host)
    })

    it('returns null when the guest already owns focus', () => {
      const guest = makeContents(42)
      focusedMock.mockReturnValue(asWebContents(guest))

      expect(captureHostFocus(42)).toBeNull()
    })

    it('returns null when nothing is focused', () => {
      focusedMock.mockReturnValue(asWebContents(null))

      expect(captureHostFocus(42)).toBeNull()
    })

    it('returns null when the focused contents is already destroyed', () => {
      focusedMock.mockReturnValue(asWebContents(makeContents(1, true)))

      expect(captureHostFocus(42)).toBeNull()
    })
  })

  describe('restoreHostFocus', () => {
    it('re-focuses the host after the guest stole focus', () => {
      const host = makeContents(1)
      const guest = makeContents(42)
      focusedMock.mockReturnValue(asWebContents(guest))

      restoreHostFocus(asWebContents(host))

      expect(host.focus).toHaveBeenCalledTimes(1)
    })

    it('does not re-focus when the host never lost focus', () => {
      const host = makeContents(1)
      focusedMock.mockReturnValue(asWebContents(host))

      restoreHostFocus(asWebContents(host))

      expect(host.focus).not.toHaveBeenCalled()
    })

    it('is a no-op when nothing was captured', () => {
      expect(() => restoreHostFocus(null)).not.toThrow()
      expect(focusedMock).not.toHaveBeenCalled()
    })

    it('does not touch a host that was destroyed while the click ran', () => {
      const host = makeContents(1, true)

      restoreHostFocus(asWebContents(host))

      expect(host.focus).not.toHaveBeenCalled()
      expect(focusedMock).not.toHaveBeenCalled()
    })

    it('still restores when the dispatch that stole focus rejected', async () => {
      const host = makeContents(1)
      const guest = makeContents(42)
      focusedMock.mockReturnValue(asWebContents(guest))

      // Why: callers wrap the mouse dispatch in try/finally so a rejected or
      // timed-out press cannot strand focus on the guest (#8139).
      const captured = asWebContents(host)
      await expect(
        (async () => {
          try {
            throw new Error('Input.dispatchMouseEvent timed out')
          } finally {
            restoreHostFocus(captured)
          }
        })()
      ).rejects.toThrow('timed out')

      expect(host.focus).toHaveBeenCalledTimes(1)
    })

    it('restores when focus landed on some third view', () => {
      const host = makeContents(1)
      focusedMock.mockReturnValue(asWebContents(makeContents(7)))

      restoreHostFocus(asWebContents(host))

      expect(host.focus).toHaveBeenCalledTimes(1)
    })
  })
})
