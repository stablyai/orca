import { useContext, useEffect, useState } from 'react'
import { Image, Pressable, StyleSheet, Text } from 'react-native'
import { MarkdownLinkHandlerContext } from './markdown-link-handler'
import { styles as markdownStyles } from './mobile-markdown-styles'
import { pressedStyle } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

type Size = { width: number; height: number }

/** An https image in GitHub text (PR bodies, comments, Tasks), at its authored width or its own,
 *  never wider than the text; a tap opens it like a link. One that can't load stays a link. */
export function MobileMarkdownRemoteImage({
  uri,
  alt,
  width
}: {
  uri: string
  alt: string
  width?: number
}) {
  useMobileColorScheme()
  const [size, setSize] = useState<Size | 'failed' | null>(null)
  const onOpenLink = useContext(MarkdownLinkHandlerContext)
  useEffect(() => {
    let live = true
    Image.getSize(
      uri,
      (naturalWidth, naturalHeight) =>
        live && setSize({ width: naturalWidth, height: naturalHeight }),
      () => live && setSize('failed')
    )
    return () => {
      live = false
    }
  }, [uri])
  if (size === 'failed') {
    return (
      <Text style={markdownStyles.link} onPress={() => onOpenLink(uri)}>
        {alt || uri}
      </Text>
    )
  }
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={alt || undefined}
      style={({ pressed }) => [
        styles.frame,
        { maxWidth: width ?? size?.width },
        pressed && pressedStyle
      ]}
      disabled={!size}
      onPress={() => onOpenLink(uri)}
    >
      <Image
        source={{ uri }}
        resizeMode="contain"
        style={size ? { width: '100%', aspectRatio: size.width / size.height } : styles.loading}
      />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  frame: { width: '100%' },
  loading: { width: '100%', height: 0 }
})
