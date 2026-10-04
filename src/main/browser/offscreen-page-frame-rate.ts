import type { WebContents } from 'electron'

// Why not 0: hidden pages still paint so agent screenshots and the mobile screencast see fresh
// content. Idle pages produce no frames at any rate; this only caps animating ones.
const HIDDEN_FRAME_RATE = 10
// Why not the display's rate: every frame is a full-page texture copied into the pane, so a page
// animating at 120Hz costs twice what 60 does with no visible gain for web content.
const SHOWN_FRAME_RATE = 60
// Why boost on input: Chromium acks pointer input on the next frame, so an agent driving a hidden
// page at the idle rate would wait up to 100ms per mouse event instead of one display frame.
const INPUT_BOOST_MS = 3000

export type OffscreenPageFrameRate = {
  setVisible(visible: boolean): void
  /** Whether the page's pane is on screen, so its frames are worth delivering. */
  readonly visible: boolean
  dispose(): void
}

/** Paces an offscreen page: 60fps while shown or driven, slow otherwise. */
export function createOffscreenPageFrameRate(contents: WebContents): OffscreenPageFrameRate {
  let visible: boolean | null = null
  let boostTimer: ReturnType<typeof setTimeout> | null = null

  const apply = (): void => {
    if (!contents.isDestroyed()) {
      contents.setFrameRate(visible || boostTimer ? SHOWN_FRAME_RATE : HIDDEN_FRAME_RATE)
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
      // Why: every pane resize syncs the viewport; only a change of visibility needs repacing.
      if (next === visible) {
        return
      }
      visible = next
      apply()
      if (next && !contents.isDestroyed()) {
        // Why: a newly shown pane needs a frame even when the page itself is idle.
        contents.invalidate()
      }
    },
    get visible() {
      return visible === true
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
