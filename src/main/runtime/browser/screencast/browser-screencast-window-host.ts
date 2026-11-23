import { getRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'

export const HOST_SCREEN_LOCKED_MESSAGE =
  "The host's screen is locked, so this page can't draw. Unlock the host to see it again."
const HOST_DISPLAY_ASLEEP_MESSAGE =
  "This page didn't draw on the host. The host's display may be asleep."

export type ScreencastWindowHostHold = {
  release: () => void
  /** Why no first frame came, when the host's screen explains it. */
  noFrameMessage: () => string | undefined
}

/** A window host's pages are webviews that draw only while its window is drawn and its screen is on and unlocked. */
export function holdScreencastWindowHost(
  windowId: number | null,
  onScreenLocked: (message: string) => void
): ScreencastWindowHostHold {
  // Offscreen pages keep their own frame clock, so a headless host holds nothing.
  if (windowId === null) {
    return { release: () => {}, noFrameMessage: () => undefined }
  }
  const desktop = getRuntimeDesktopSurface()
  // Hidden host compositors stop producing guest frames when throttled.
  const releasePublication = desktop.holdRendererPublication?.(windowId)
  const releaseDisplay = desktop.holdDisplayAwake?.()
  const stopLockWatch = desktop.onScreenLocked?.(() => onScreenLocked(HOST_SCREEN_LOCKED_MESSAGE))
  return {
    release: () => {
      releasePublication?.()
      releaseDisplay?.()
      stopLockWatch?.()
    },
    noFrameMessage: () => {
      const state = desktop.readScreenState?.()
      return state === 'locked'
        ? HOST_SCREEN_LOCKED_MESSAGE
        : state === 'idle'
          ? HOST_DISPLAY_ASLEEP_MESSAGE
          : undefined
    }
  }
}
