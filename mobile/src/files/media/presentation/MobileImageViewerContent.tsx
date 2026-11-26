import { Image } from 'react-native'
import { isSvgDataUri, MobileSvgImage } from './MobileSvgImage'
import type { MobilePanZoomImage } from './MobilePanZoomImage'

export function MobileImageViewerContent({ uri, label }: Parameters<typeof MobilePanZoomImage>[0]) {
  return isSvgDataUri(uri) ? (
    <MobileSvgImage uri={uri} label={label} />
  ) : (
    <Image
      source={{ uri }}
      accessibilityLabel={label}
      resizeMode="contain"
      style={{ width: '100%', height: '100%' }}
    />
  )
}
