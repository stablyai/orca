import type { WebContents } from 'electron'
import type { BrowserScreencastFrameMetadata } from '../../../../shared/browser/screencast/browser-screencast-protocol'
import type { BrowserScreencastDeviceMetrics } from './browser-screencast-device-metrics'
import {
  clampScreencastViewportToGuestView,
  isEmbedderSizedScreencastGuest,
  readScreencastGuestViewSize,
  type BrowserScreencastGuestViewSize
} from './browser-screencast-guest-view-limit'
import type {
  BrowserScreencastOptions,
  BrowserScreencastViewport
} from './browser-screencast-stream-types'

export type BrowserScreencastEmulatedViewport = {
  /** A viewer asked for this viewport; the guest view limit may shrink what is emulated. */
  request: (viewport: BrowserScreencastViewport) => void
  applyDeviceMetricsOverride: () => Promise<void>
  /** True while guest frames must be dropped pending re-emulation. */
  observeGuestViewSize: (metadata: BrowserScreencastFrameMetadata) => boolean
}

/** The page's one emulated viewport, which every lane of its stream shows. */
export function createBrowserScreencastEmulatedViewport(deps: {
  webContents: WebContents
  options: BrowserScreencastOptions
  deviceMetrics: BrowserScreencastDeviceMetrics
  onViewport: (viewport: BrowserScreencastViewport) => void
  reemulate: () => Promise<void>
}): BrowserScreencastEmulatedViewport {
  const { options, deviceMetrics } = deps
  // Preserve the client request so the viewport can grow back after the guest view limit shrinks it.
  const embedderSizedGuest = isEmbedderSizedScreencastGuest(deps.webContents)
  let requestedViewport: BrowserScreencastViewport = {
    viewportWidth: options.viewportWidth,
    viewportHeight: options.viewportHeight,
    deviceScaleFactor: options.deviceScaleFactor,
    mobile: options.mobile
  }
  let guestViewSize: BrowserScreencastGuestViewSize | null = null
  let emulationGeneration = 0
  let appliedEmulationGeneration = 0
  const applyEffectiveViewport = (): boolean => {
    const next = clampScreencastViewportToGuestView(requestedViewport, guestViewSize)
    const changed =
      next.viewportWidth !== options.viewportWidth || next.viewportHeight !== options.viewportHeight
    Object.assign(options, next)
    deps.onViewport(next)
    if (changed) {
      emulationGeneration += 1
    }
    return changed
  }

  return {
    request: (viewport) => {
      requestedViewport = { ...viewport }
      applyEffectiveViewport()
    },
    applyDeviceMetricsOverride: () => {
      const generation = emulationGeneration
      const applied = deviceMetrics.apply()
      // Advance even on failure so a rejected metrics write cannot suppress live frames forever.
      const markApplied = (): void => {
        appliedEmulationGeneration = Math.max(appliedEmulationGeneration, generation)
      }
      applied.then(markApplied, markApplied)
      return applied
    },
    observeGuestViewSize: (metadata) => {
      if (!embedderSizedGuest) {
        return false
      }
      const size = readScreencastGuestViewSize(metadata)
      if (size && (guestViewSize?.width !== size.width || guestViewSize.height !== size.height)) {
        guestViewSize = size
        if (applyEffectiveViewport()) {
          void deps.reemulate().catch(() => {})
        }
      }
      // Reject old-layout crops until queued viewport metrics have landed.
      return appliedEmulationGeneration < emulationGeneration
    }
  }
}
