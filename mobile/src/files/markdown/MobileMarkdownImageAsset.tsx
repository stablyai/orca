import { useEffect, useState } from 'react'
import { ActivityIndicator, Image } from 'react-native'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { isSvgDataUri, MobileSvgImage } from '../media/presentation/MobileSvgImage'

export type MobileMarkdownImageAssetProps = {
  uri: string
  label: string
  width?: number
  availableWidth: number
  onError: () => void
}

export function MobileMarkdownImageAsset(props: MobileMarkdownImageAssetProps) {
  return isSvgDataUri(props.uri) ? (
    <MobileSvgImage {...props} />
  ) : (
    <MobileMarkdownRasterImage {...props} />
  )
}

function MobileMarkdownRasterImage({
  uri,
  label,
  width,
  availableWidth,
  onError
}: MobileMarkdownImageAssetProps) {
  const colors = useMobileColors()
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    let live = true
    void Image.getSize(uri).then(
      (naturalSize) => {
        if (!live) {
          return
        }
        if (naturalSize.width <= 0 || naturalSize.height <= 0) {
          onError()
          return
        }
        setSize(naturalSize)
      },
      () => {
        if (live) {
          onError()
        }
      }
    )
    return () => {
      live = false
    }
  }, [uri, onError])

  if (!size || availableWidth <= 0) {
    return <ActivityIndicator color={colors.textSecondary} />
  }
  const imageWidth = Math.min(width ?? size.width, availableWidth)
  return (
    <Image
      source={{ uri }}
      accessibilityLabel={label}
      resizeMode="contain"
      style={{ width: imageWidth, height: (imageWidth * size.height) / size.width }}
      onError={onError}
    />
  )
}
