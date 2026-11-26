import { isSvgDataUri, MobileSvgImage } from './MobileSvgImage'
import type { MobilePanZoomImage } from './MobilePanZoomImage'
import { MobileNativePanZoomImage } from './MobileNativePanZoomImage'

export function MobileImageViewerContent(props: Parameters<typeof MobilePanZoomImage>[0]) {
  return isSvgDataUri(props.uri) ? (
    <MobileSvgImage uri={props.uri} label={props.label} onError={props.onError} />
  ) : (
    <MobileNativePanZoomImage {...props} />
  )
}
