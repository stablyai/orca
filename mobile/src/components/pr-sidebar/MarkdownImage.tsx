import { useState } from 'react'
import { Image, Linking, Pressable, StyleSheet, Text } from 'react-native'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { isAllowedMarkdownLinkUrl } from './markdown-link-scheme'

type Props = {
  uri: string
  alt: string
  base: number
  // Outer link target of a linked image `[![alt](uri)](href)`; tapping navigates here.
  href?: string
}

function openUri(uri: string): void {
  void Linking.openURL(uri).catch(() => {})
}

// Renders a PR-body markdown image inline (screenshots are the common case). Width fills
// the container and aspectRatio — read from the loaded image — drives the height, so no
// container measurement is needed. Tapping opens the source (e.g. full-size in the
// browser). On load error or a disallowed scheme it degrades to a text link: private-repo
// attachments (github.com/user-attachments/…) need the user's GitHub session, which the
// device doesn't have, so they can't load here.
export function MarkdownImage({ uri, alt, base, href }: Props) {
  const [aspectRatio, setAspectRatio] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const allowed = isAllowedMarkdownLinkUrl(uri)
  // Navigate to the outer link when it's a safe scheme, otherwise the image itself.
  const target = href && isAllowedMarkdownLinkUrl(href) ? href : uri

  if (failed || !allowed) {
    return (
      <Text
        style={[styles.fallback, { fontSize: base }]}
        onPress={isAllowedMarkdownLinkUrl(target) ? () => openUri(target) : undefined}
      >
        {alt || uri}
      </Text>
    )
  }

  return (
    <Pressable onPress={() => openUri(target)} accessibilityRole="imagebutton">
      <Image
        source={{ uri }}
        accessibilityLabel={alt || undefined}
        style={[styles.image, aspectRatio ? { aspectRatio } : styles.imageLoading]}
        resizeMode="contain"
        onLoad={(event) => {
          const { width, height } = event.nativeEvent.source
          if (width > 0 && height > 0) {
            setAspectRatio(width / height)
          }
        }}
        onError={() => setFailed(true)}
      />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  image: {
    width: '100%',
    borderRadius: radii.row,
    backgroundColor: colors.bgRaised,
    marginBottom: spacing.sm
  },
  // Placeholder height until the natural aspect ratio arrives on first load.
  imageLoading: { height: 180 },
  fallback: {
    color: colors.textPrimary,
    textDecorationLine: 'underline',
    marginBottom: spacing.sm
  }
})
