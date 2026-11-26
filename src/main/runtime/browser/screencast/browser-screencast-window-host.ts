import { getRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'
import type { RuntimeBrowserCommandHost } from '../commands/browser-command-contracts'

const HOST_SCREEN_LOCKED_MESSAGE =
  "The host's screen is locked, so this page can't draw. Reconnect once the host is unlocked."
const HOST_DISPLAY_ASLEEP_MESSAGE =
  "This page didn't draw on the host. The host's display may be asleep."

export type ScreencastWindowHostHold = {
  release: () => void
  /** Why no first frame came, when the host's screen explains it. */
  noFrameMessage: () => string | undefined
}

/** A window host's pages are webviews that draw only while its window is drawn and its screen is on and unlocked. */
export function holdScreencastWindowHost(
  guest: {
    getType(): string
    isDestroyed(): boolean
    isOffscreen(): boolean
    // Electron exposes these capturer methods at runtime though its WebContents d.ts omits them.
    incrementCapturerCount?: (
      size?: { width: number; height: number },
      stayHidden?: boolean
    ) => void
    decrementCapturerCount?: (stayHidden?: boolean) => void
  },
  host: Pick<RuntimeBrowserCommandHost, 'getAvailableAuthoritativeWindowId'>,
  onScreenLocked: (message: string) => void
): ScreencastWindowHostHold {
  // Hidden native popup windows (show: false) need a stayHidden capturer lease so Chromium keeps compositing live frames.
  let heldStayHiddenCapturer = false
  if (
    guest.getType() !== 'webview' &&
    !guest.isOffscreen() &&
    guest.incrementCapturerCount &&
    guest.decrementCapturerCount
  ) {
    try {
      guest.incrementCapturerCount(undefined, true)
      heldStayHiddenCapturer = true
    } catch {}
  }
  const releaseCapturer = (): void => {
    if (!heldStayHiddenCapturer) {
      return
    }
    heldStayHiddenCapturer = false
    try {
      if (!guest.isDestroyed()) {
        guest.decrementCapturerCount?.(true)
      }
    } catch {}
  }
  // Offscreen pages, including those a serve host keeps after a desktop attaches, keep their own frame clock.
  const windowId = guest.getType() === 'webview' ? host.getAvailableAuthoritativeWindowId() : null
  if (windowId === null) {
    return { release: releaseCapturer, noFrameMessage: () => undefined }
  }
  const desktop = getRuntimeDesktopSurface()
  // Hidden host compositors stop producing guest frames when throttled.
  const releasePublication = desktop.holdRendererPublication?.(windowId)
  const releaseDisplay = desktop.holdDisplayAwake?.()
  const stopLockWatch = desktop.onScreenLocked?.(() => onScreenLocked(HOST_SCREEN_LOCKED_MESSAGE))
  return {
    release: () => {
      releaseCapturer()
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
