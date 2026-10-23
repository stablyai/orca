import { useEffect, useState } from 'react'
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, textStyles } from '../theme/mobile-theme'
import { MobileLoadErrorState } from '../components/MobileLoadErrorState'
import { MobileNativeChatImageViewer } from '../session/MobileNativeChatImageViewer'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { loadMarkdownPreviewImage } from './mobile-markdown-image-source'

type Props = {
  client: MobileFilePreviewRpcSender | null
  worktreeId: string
  documentPath: string
  href: string
  alt: string
}

export function MobileMarkdownPreviewImage({ client, worktreeId, documentPath, href, alt }: Props) {
  const [load, setLoad] = useState<{ uri?: string; error?: string }>({})
  const [attempt, setAttempt] = useState(0)
  const [aspectRatio, setAspectRatio] = useState(16 / 9)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    let cancelled = false
    void loadMarkdownPreviewImage(client, worktreeId, documentPath, href).then(
      (uri) => {
        if (!cancelled) {
          setLoad({ uri })
          Image.getSize(
            uri,
            (width, height) => {
              if (!cancelled && width > 0 && height > 0) {
                setAspectRatio(width / height)
              }
            },
            () => {}
          )
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoad({ error: error instanceof Error ? error.message : 'Unable to load image' })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [client, worktreeId, documentPath, href, attempt])

  return (
    <View style={styles.frame}>
      {load.error ? (
        <MobileLoadErrorState
          message={load.error}
          onRetry={() => {
            setLoad({})
            setAttempt((value) => value + 1)
          }}
        />
      ) : load.uri ? (
        <Pressable
          onPress={() => setExpanded(true)}
          accessibilityRole="button"
          accessibilityLabel={`Expand ${alt || 'image'}`}
        >
          <Image
            source={{ uri: load.uri }}
            accessibilityLabel={alt || 'Markdown image'}
            resizeMode="contain"
            style={[styles.image, { aspectRatio }]}
            onError={() => setLoad({ error: 'Unable to load image' })}
          />
        </Pressable>
      ) : (
        <View style={styles.loading}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      )}
      {alt ? <Text style={styles.caption}>{alt}</Text> : null}
      {expanded && load.uri ? (
        <MobileNativeChatImageViewer
          uri={load.uri}
          label={alt || 'Markdown image'}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  frame: { gap: spacing.sm },
  image: { width: '100%', borderRadius: radii.field },
  loading: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.field,
    backgroundColor: colors.fill
  },
  caption: { ...textStyles.footnote, color: colors.textSecondary }
})
