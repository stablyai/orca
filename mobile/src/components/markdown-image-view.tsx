import { useState } from 'react'
import { Image, Pressable } from 'react-native'
import {
  MARKDOWN_INLINE_IMAGE_HEIGHT,
  MARKDOWN_INLINE_IMAGE_WIDTH,
  styles
} from './mobile-markdown-styles'

type BlockProps = {
  uri: string
  alt: string
  onPress?: () => void
}

/** A standalone markdown image: full width, intrinsic aspect once loaded, tap opens the file. */
export function MarkdownImageView({ uri, alt, onPress }: BlockProps) {
  const [aspect, setAspect] = useState<number | null>(null)
  return (
    <Pressable
      style={styles.markdownImageFrame}
      onPress={onPress}
      disabled={!onPress}
      accessibilityLabel={alt || 'image'}
    >
      <Image
        source={{ uri }}
        style={
          aspect === null ? styles.markdownImageSizing : { width: '100%', aspectRatio: aspect }
        }
        resizeMode="contain"
        onLoad={(event) => {
          const source = event.nativeEvent.source
          if (source.width > 0 && source.height > 0) {
            setAspect(source.width / source.height)
          }
        }}
      />
    </Pressable>
  )
}

type InlineProps = {
  uri: string
  alt: string
  /** Pinch-driven multiplier from the document's textScale; 1 leaves the sheet size alone. */
  sizeScale?: number
}

/** A fixed-size thumbnail for images inline in prose and table cells. */
export function MarkdownInlineImage({ uri, alt, sizeScale = 1 }: InlineProps) {
  return (
    <Image
      source={{ uri }}
      style={
        sizeScale !== 1
          ? {
              width: MARKDOWN_INLINE_IMAGE_WIDTH * sizeScale,
              height: MARKDOWN_INLINE_IMAGE_HEIGHT * sizeScale,
              marginVertical: 2
            }
          : styles.markdownInlineImage
      }
      resizeMode="contain"
      accessibilityLabel={alt || 'image'}
    />
  )
}
