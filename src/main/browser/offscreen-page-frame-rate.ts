import { screen } from 'electron'
import type { WebContents } from 'electron'

// Why not 0: hidden pages still paint so agent screenshots and the mobile screencast see fresh
// content. Idle pages produce no frames at any rate; this only caps animating ones.
const HIDDEN_FRAME_RATE = 10
// Why boost on input: Chromium acks pointer input on the next frame, so an agent driving a hidden
// page at the idle rate would wait up to 100ms per mouse event instead of one display frame.
const INPUT_BOOST_MS = 3000

export type OffscreenPageFrameRate = {
  setVisible(visible: boolean): void
  dispose(): void
}

/** Paces an offscreen page: the display's refresh rate while shown or driven, slow otherwise. */
export function createOffscreenPageFrameRate(contents: WebContents): OffscreenPageFrameRate {
  let visible = false
  let boostTimer: ReturnType<typeof setTimeout> | null = null

  const apply = (): void => {
    if (!contents.isDestroyed()) {
      contents.setFrameRate(visible || boostTimer ? displayFrameRate() : HIDDEN_FRAME_RATE)
    }
  }
  const onInput = (): void => {
    if (visible) {
      return
    }
    const wasBoosted = boostTimer !== null
    if (boostTimer) {
      clearTimeout(boostTimer)
    }
    boostTimer = setTimeout(() => {
      boostTimer = null
      apply()
    }, INPUT_BOOST_MS)
    if (!wasBoosted) {
      apply()
    }
  }
  contents.on('input-event', onInput)

  return {
    setVisible(next) {
      visible = next
      apply()
      if (next && !contents.isDestroyed()) {
        // Why: a newly shown pane needs a frame even when the page itself is idle.
        contents.invalidate()
      }
    },
    dispose() {
      if (boostTimer) {
        clearTimeout(boostTimer)
        boostTimer = null
      }
      if (!contents.isDestroyed()) {
        contents.off('input-event', onInput)
      }
    }
  }
}

function displayFrameRate(): number {
  const fastest = Math.max(...screen.getAllDisplays().map((d) => d.displayFrequency || 0), 60)
  return Math.min(Math.round(fastest), 240)
}
