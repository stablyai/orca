import type {
  BrowserScreencastFrameBudget,
  BrowserScreencastOptions,
  ScreencastImageSize
} from './browser-screencast-stream-types'

// Live frames this close together mean the page is scrolling or animating.
const MOTION_FRAME_GAP_MS = 100
// The page counts as still once no live frame came for this long.
const MOTION_QUIET_MS = 150
const MOTION_QUALITY = 50
// Page.startScreencast's smallest useful cap, as the budget normalizer clamps it.
const MOTION_MIN_WIDTH = 320
const MOTION_MIN_HEIGHT = 240

export type BrowserScreencastMotionQuality = {
  noteLiveFrame: (imageSize: ScreencastImageSize | null) => void
  /** The viewers' budget changed; while in motion only its pace applies at once. */
  setFullBudget: (budget: BrowserScreencastFrameBudget) => void
  dispose: () => void
}

/**
 * While the page moves and a viewer's link holds frames back, encode at half size and lower
 * quality so motion stays fluid; once it is still, restore the full budget and send a sharp frame.
 */
export function createBrowserScreencastMotionQuality(deps: {
  /** What Chromium encodes now; this module lowers and restores its size and quality. */
  options: BrowserScreencastOptions
  isBacklogged: () => boolean
  restartScreencast: () => void
  sendSharpFrame: () => void
}): BrowserScreencastMotionQuality {
  const { options } = deps
  let full: BrowserScreencastFrameBudget = pickBudget(options)
  let lowered: Pick<BrowserScreencastFrameBudget, 'maxWidth' | 'maxHeight'> | null = null
  let lastLiveFrameAt = 0
  let quietTimer: ReturnType<typeof setTimeout> | null = null

  const applyLowered = (): void => {
    if (!lowered) {
      return
    }
    Object.assign(options, {
      quality: Math.min(full.quality, MOTION_QUALITY),
      maxWidth: Math.min(full.maxWidth, lowered.maxWidth),
      maxHeight: Math.min(full.maxHeight, lowered.maxHeight)
    })
  }

  const armQuietTimer = (): void => {
    if (quietTimer) {
      clearTimeout(quietTimer)
    }
    quietTimer = setTimeout(() => {
      quietTimer = null
      lowered = null
      Object.assign(options, full)
      deps.restartScreencast()
      // The last frames the viewers got were the lowered ones.
      deps.sendSharpFrame()
    }, MOTION_QUIET_MS)
  }

  return {
    noteLiveFrame: (imageSize) => {
      const now = Date.now()
      const inMotion = now - lastLiveFrameAt < MOTION_FRAME_GAP_MS
      lastLiveFrameAt = now
      if (lowered) {
        armQuietTimer()
        return
      }
      if (!inMotion || !imageSize || !deps.isBacklogged()) {
        return
      }
      lowered = {
        maxWidth: Math.max(MOTION_MIN_WIDTH, Math.ceil(imageSize.width / 2)),
        maxHeight: Math.max(MOTION_MIN_HEIGHT, Math.ceil(imageSize.height / 2))
      }
      applyLowered()
      deps.restartScreencast()
      armQuietTimer()
    },
    setFullBudget: (budget) => {
      full = pickBudget(budget)
      Object.assign(options, full)
      applyLowered()
    },
    dispose: () => {
      if (quietTimer) {
        clearTimeout(quietTimer)
        quietTimer = null
      }
    }
  }
}

function pickBudget(budget: BrowserScreencastFrameBudget): BrowserScreencastFrameBudget {
  return {
    quality: budget.quality,
    maxWidth: budget.maxWidth,
    maxHeight: budget.maxHeight,
    everyNthFrame: budget.everyNthFrame,
    minFrameIntervalMs: budget.minFrameIntervalMs
  }
}
