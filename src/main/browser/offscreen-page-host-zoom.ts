import type { WebContents } from 'electron'
import type { OffscreenPageGuestEvent } from '../../shared/offscreen-page-protocol'
import {
  OFFSCREEN_PAGE_EVENT_CHANNEL,
  readOffscreenPageGuestState
} from './offscreen-page-guest-events'

/** The showing renderer's own zoom; its CSS px are `factor` page DIPs. */
export type OffscreenPageHostZoom = { level: number; factor: number }

/**
 * Mirrors a <webview>: when the host's UI zoom changes, the page adopts the same zoom level, so it
 * keeps its CSS size on screen and renders at the host's sharper pixel ratio. Called on viewport
 * sync because every UI zoom change resizes the element. Returns the zoom now in effect.
 */
export function syncOffscreenPageHostZoom(args: {
  browserPageId: string
  contents: WebContents
  renderer: WebContents | null
  current: OffscreenPageHostZoom | null
}): OffscreenPageHostZoom | null {
  const { renderer, contents, current } = args
  if (!renderer) {
    return current
  }
  const level = renderer.getZoomLevel()
  if (current?.level === level) {
    return current
  }
  contents.setZoomLevel(level)
  const event: OffscreenPageGuestEvent = {
    type: 'state',
    detail: {},
    state: readOffscreenPageGuestState(contents)
  }
  renderer.send(OFFSCREEN_PAGE_EVENT_CHANNEL, args.browserPageId, event)
  return { level, factor: renderer.getZoomFactor() }
}
