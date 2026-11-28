import { MarkdownImageLayout } from '../../components/markdown/blocks/MobileMarkdownImageRow'
import { useContext, useEffect, useState } from 'react'
import { ActivityIndicator, Dimensions, Image, Pressable, Text, View } from 'react-native'
import { spacing, typography, pressedStyle } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { MobileLoadErrorState } from '../../components/feedback/MobileStateView'
import { MobileImageViewer } from '../media/presentation/MobileImageViewer'
import { MobileImageViewerActions } from '../../session/native-chat/visual/MobileImageViewerActions'
import type { MobileFilePreviewRpcSender } from '../preview/mobile-file-preview-operations'
import { loadMarkdownPreviewImage } from './mobile-markdown-image-source'
import { translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'

type Props = {
  client: MobileFilePreviewRpcSender | null
  worktreeId: string
  documentPath: string
  href: string
  alt: string
  width?: number
}

export function MobileMarkdownPreviewImage({
  client,
  worktreeId,
  documentPath,
  href,
  alt,
  width
}: Props) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const inRow = useContext(MarkdownImageLayout) === 'row'
  const [load, setLoad] = useState<{ uri?: string; error?: string }>({})
  const [attempt, setAttempt] = useState(0)
  const [size, setSize] = useState<{ width: number; height: number } | null>()
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
              if (!cancelled) {
                setSize(width > 0 && height > 0 ? { width, height } : null)
              }
            },
            () => {
              if (!cancelled) {
                setSize(null)
              }
            }
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

  // A failed size probe can still leave a drawable image. Give it the available column.
  const rowWidth = width ?? (size === null ? Dimensions.get('window').width : size?.width)
  return (
    <View style={[styles.frame, inRow && !load.error && { width: rowWidth, maxWidth: '100%' }]}>
      {load.error ? (
        <MobileLoadErrorState
          error={load.error}
          onRetry={() => {
            setLoad({})
            setAttempt((value) => value + 1)
          }}
        />
      ) : load.uri ? (
        <Pressable
          style={({ pressed }) => pressed && pressedStyle}
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
            style={{ width: '100%', aspectRatio: size ? size.width / size.height : 16 / 9 }}
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
      {alt && (!inRow || load.error) ? <Text style={styles.caption}>{alt}</Text> : null}
      {expanded && load.uri ? (
        <MobileImageViewer
          uri={load.uri}
          label={alt || t('files.markdownPreviewImage.imageLabel', 'Markdown image')}
          actions={MobileImageViewerActions}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  frame: { gap: spacing.xs },
  caption: { color: colors.textSecondary, fontSize: typography.metaSize }
}))
