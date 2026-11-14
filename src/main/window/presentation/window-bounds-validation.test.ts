import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from 'electron'
import { rectHasVisibleAreaOnAnyDisplay, resolveRestoredBounds } from './window-bounds-validation'

vi.mock('electron', () => ({
  screen: {
    getAllDisplays: vi.fn()
  }
}))

describe('window-bounds-validation', () => {
  const mockDisplays = [
    {
      id: 1,
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    },
    {
      id: 2,
      workArea: { x: 1920, y: 0, width: 1920, height: 1080 }
    }
  ]

  beforeEach(() => {
    vi.mocked(screen.getAllDisplays).mockReturnValue(mockDisplays as unknown as Electron.Display[])
  })

  describe('rectHasVisibleAreaOnAnyDisplay', () => {
    it('returns true when rect overlaps sufficiently with a display workArea', () => {
      const rect = { x: 100, y: 100, width: 800, height: 600 }
      expect(rectHasVisibleAreaOnAnyDisplay(rect, 240, 180)).toBe(true)
    })

    it('returns true when rect is on secondary display', () => {
      const rect = { x: 2000, y: 100, width: 800, height: 600 }
      expect(rectHasVisibleAreaOnAnyDisplay(rect, 240, 180)).toBe(true)
    })

    it('returns false when rect has less than minimum visible overlap', () => {
      // Placed off to the left with only 100px visible on display 1:
      const offLeft = { x: -700, y: 100, width: 800, height: 600 }
      // overlap with display 1: Math.min(100, 1920) - Math.max(-700, 0) = 100 - 0 = 100px (< 240)
      expect(rectHasVisibleAreaOnAnyDisplay(offLeft, 240, 180)).toBe(false)
    })

    it('returns false when completely off-screen', () => {
      const rect = { x: 5000, y: 5000, width: 800, height: 600 }
      expect(rectHasVisibleAreaOnAnyDisplay(rect, 240, 180)).toBe(false)
    })

    it('handles screen.getAllDisplays() throwing gracefully', () => {
      vi.mocked(screen.getAllDisplays).mockImplementationOnce(() => {
        throw new Error('Display service unavailable')
      })
      const rect = { x: 100, y: 100, width: 800, height: 600 }
      expect(rectHasVisibleAreaOnAnyDisplay(rect, 240, 180)).toBe(false)
    })
  })

  describe('resolveRestoredBounds', () => {
    it('returns valid bounds within display', () => {
      const valid = { x: 100, y: 100, width: 960, height: 720 }
      expect(resolveRestoredBounds(valid)).toEqual(valid)
    })

    it('returns null when bounds is null or undefined', () => {
      expect(resolveRestoredBounds(null)).toBeNull()
      expect(resolveRestoredBounds(undefined)).toBeNull()
    })

    it('returns null when bounds is below minimum dimensions (480x360)', () => {
      const tooNarrow = { x: 100, y: 100, width: 479, height: 600 }
      expect(resolveRestoredBounds(tooNarrow)).toBeNull()

      const tooShort = { x: 100, y: 100, width: 800, height: 359 }
      expect(resolveRestoredBounds(tooShort)).toBeNull()
    })

    it('returns null when bounds is off-screen across all displays', () => {
      const offScreen = { x: -2000, y: -2000, width: 960, height: 720 }
      expect(resolveRestoredBounds(offScreen)).toBeNull()
    })

    it('supports custom min dimensions and log tag', () => {
      const customBounds = { x: 50, y: 50, width: 300, height: 200 }
      expect(
        resolveRestoredBounds(customBounds, { minWidth: 200, minHeight: 150, logTag: '[test]' })
      ).toEqual(customBounds)
    })
  })
})
