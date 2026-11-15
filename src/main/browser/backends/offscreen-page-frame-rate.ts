import type { WebContents } from 'electron'
import { rendererPublicationThrottle } from '../../window/visibility/renderer-publication-throttle'

// Offscreen pages composite on their own frame clock whether or not anything reads the frames.
// Unwatched pages tick a few times a second, so a capture waits at most one slow tick.
const UNWATCHED_FRAME_RATE = 5
const WATCHED_FRAME_RATE = 60
// Spans an agent's thinking between steps, so a run of commands keeps full-rate frames ready.
const WATCHED_GRACE_MS = 20_000

/** Runs the page at full rate while a command, capture or screencast lease needs its frames. */
export function followPublicationLeasesWithFrameRate(contents: WebContents): void {
  let slowDown: ReturnType<typeof setTimeout> | undefined
  let current = UNWATCHED_FRAME_RATE
  const setRate = (rate: number): void => {
    current = rate
    if (!contents.isDestroyed()) {
      contents.setFrameRate(rate)
    }
  }
  setRate(UNWATCHED_FRAME_RATE)
  // A cross-site view created before a rate change commits with the old rate; reapply on commit.
  contents.on('did-navigate', () => setRate(current))
  const stopObserving = rendererPublicationThrottle.observe(contents, (leased) => {
    clearTimeout(slowDown)
    if (leased) {
      setRate(WATCHED_FRAME_RATE)
    } else {
      slowDown = setTimeout(() => setRate(UNWATCHED_FRAME_RATE), WATCHED_GRACE_MS)
    }
  })
  contents.once('destroyed', () => {
    clearTimeout(slowDown)
    stopObserving()
  })
}
