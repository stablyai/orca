import { useEffect, useState } from 'react'
import { ActivityIndicator, Image, Pressable, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MobileLoadErrorState } from '../components/MobileLoadErrorState'
import { MobileNativeChatImageViewer } from '../session/native-chat/visual/MobileNativeChatImageViewer'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { loadMarkdownPreviewImage } from './mobile-markdown-image-source'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

type Props = {
  client: MobileFilePreviewRpcSender | null
  worktreeId: string
  documentPath: string
  href: string
  alt: string
}

export function MobileMarkdownPreviewImage({ client, worktreeId, documentPath, href, alt }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
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
          setLoad({
            error:
              error instanceof Error
                ? error.message
                : translate('files.markdownPreviewImage.loadFailed', 'Unable to load image')
          })
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
          accessibilityLabel={
            alt
              ? t('files.markdownPreviewImage.expandImage', 'Expand {{alt}}', { alt })
              : t('files.markdownPreviewImage.expandFallback', 'Expand image')
          }
        >
          <Image
            source={{ uri: load.uri }}
            accessibilityLabel={alt || t('files.markdownPreviewImage.imageLabel', 'Markdown image')}
            resizeMode="contain"
            style={{ width: '100%', aspectRatio }}
            onError={() =>
              setLoad({
                error: translate('files.markdownPreviewImage.loadFailed', 'Unable to load image')
              })
            }
          />
        </Pressable>
      ) : (
        <ActivityIndicator color={colors.textSecondary} />
      )}
      {alt ? <Text style={styles.caption}>{alt}</Text> : null}
      {expanded && load.uri ? (
        <MobileNativeChatImageViewer
          uri={load.uri}
          label={alt || t('files.markdownPreviewImage.imageLabel', 'Markdown image')}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  frame: { gap: spacing.xs },
  caption: { color: colors.textSecondary, fontSize: typography.metaSize }
}))
