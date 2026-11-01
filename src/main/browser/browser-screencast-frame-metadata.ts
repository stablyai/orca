import type { BrowserScreencastFrameMetadata } from '../../shared/browser-screencast-protocol'
import type {
  BrowserScreencastOptions,
  ScreencastImageSize
} from './browser-screencast-stream-types'
import { positiveInteger } from './browser-screencast-viewport-fit'

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function readFrameMetadata(raw: unknown): BrowserScreencastFrameMetadata {
  const metadata = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    offsetTop: finiteNumber(metadata.offsetTop),
    pageScaleFactor: finiteNumber(metadata.pageScaleFactor),
    deviceWidth: finiteNumber(metadata.deviceWidth),
    deviceHeight: finiteNumber(metadata.deviceHeight),
    imageWidth: finiteNumber(metadata.imageWidth),
    imageHeight: finiteNumber(metadata.imageHeight),
    scrollOffsetX: finiteNumber(metadata.scrollOffsetX),
    scrollOffsetY: finiteNumber(metadata.scrollOffsetY),
    timestamp: finiteNumber(metadata.timestamp)
  }
}

function selectFrameDeviceSize(
  reportedSize: number | undefined,
  requestedCssSize: number | null,
  imageSize: number | undefined
): number | undefined {
  if (requestedCssSize) {
    // Client viewport dimensions take precedence over transient host-surface dimensions.
    return requestedCssSize
  }
  return reportedSize ?? imageSize
}

export function enrichFrameMetadata(
  metadata: BrowserScreencastFrameMetadata,
  imageSize: ScreencastImageSize | null,
  options: BrowserScreencastOptions
): BrowserScreencastFrameMetadata {
  const viewportWidth = positiveInteger(options.viewportWidth)
  const viewportHeight = positiveInteger(options.viewportHeight)
  const enriched: BrowserScreencastFrameMetadata = { ...metadata }
  const deviceWidth = selectFrameDeviceSize(enriched.deviceWidth, viewportWidth, imageSize?.width)
  const deviceHeight = selectFrameDeviceSize(
    enriched.deviceHeight,
    viewportHeight,
    imageSize?.height
  )
  const imageWidth = imageSize?.width ?? enriched.imageWidth
  const imageHeight = imageSize?.height ?? enriched.imageHeight
  if (deviceWidth !== undefined) {
    enriched.deviceWidth = deviceWidth
  }
  if (deviceHeight !== undefined) {
    enriched.deviceHeight = deviceHeight
  }
  if (imageWidth !== undefined) {
    enriched.imageWidth = imageWidth
  }
  if (imageHeight !== undefined) {
    enriched.imageHeight = imageHeight
  }
  return enriched
}
