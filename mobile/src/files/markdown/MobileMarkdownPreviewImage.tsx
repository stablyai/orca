import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native'
import { spacing, typography, pressedStyle } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { MobileLoadErrorState } from '../../components/feedback/MobileStateView'
import { stylesSheet as markdownStylesSheet } from '../../components/markdown/mobile-markdown-styles'
import { MobileImageViewer } from '../media/presentation/MobileImageViewer'
import { MobileImageViewerActions } from '../../session/native-chat/visual/MobileImageViewerActions'
import type { MobileFilePreviewRpcSender } from '../preview/mobile-file-preview-operations'
import { loadMarkdownPreviewImage } from './mobile-markdown-image-source'
import { translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { MobileMarkdownImageAsset } from './MobileMarkdownImageAsset'

type Props = {
  client: MobileFilePreviewRpcSender | null
  worktreeId: string
  documentPath: string
  href: string
  alt: string
  width?: number
  onOpenLink?: () => void
}

export function MobileMarkdownPreviewImage({
  client,
  worktreeId,
  documentPath,
  href,
  alt,
  width,
  onOpenLink
}: Props) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const markdownStyles = useThemedStyles(markdownStylesSheet)
  const t = useMobileTranslation()
  const [load, setLoad] = useState<{ uri?: string; error?: string }>({})
  const [attempt, setAttempt] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [availableWidth, setAvailableWidth] = useState(0)
  const onImageError = useCallback(() => {
    setLoad({
      error: translate('files.markdownPreviewImage.loadFailed', 'Unable to load image')
    })
  }, [])
  useEffect(() => {
    let cancelled = false
    void loadMarkdownPreviewImage(client, worktreeId, documentPath, href).then(
      (uri) => {
        if (!cancelled) {
          setLoad({ uri })
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

  const label = alt || t('files.markdownPreviewImage.imageLabel', 'Markdown image')
  const fallbackLink = load.error ? onOpenLink : undefined
  return (
    <View
      style={styles.frame}
      onLayout={
        Platform.OS === 'web'
          ? undefined
          : ({ nativeEvent }) => setAvailableWidth(nativeEvent.layout.width)
      }
    >
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
          style={({ pressed }) => [styles.imageButton, pressed && pressedStyle]}
          onPress={onOpenLink ?? (() => setExpanded(true))}
          accessibilityRole={onOpenLink ? 'link' : 'button'}
          accessibilityLabel={
            onOpenLink
              ? label
              : alt
                ? t('files.markdownPreviewImage.expandImage', 'Expand {{alt}}', { alt })
                : t('files.markdownPreviewImage.expandFallback', 'Expand image')
          }
        >
          <MobileMarkdownImageAsset
            key={load.uri}
            uri={load.uri}
            label={label}
            width={width}
            availableWidth={availableWidth}
            onError={onImageError}
          />
        </Pressable>
      ) : (
        <ActivityIndicator color={colors.textSecondary} />
      )}
      {alt || fallbackLink ? (
        <Text
          style={[styles.caption, fallbackLink && markdownStyles.link]}
          onPress={fallbackLink}
          accessibilityRole={fallbackLink ? 'link' : undefined}
        >
          {label}
        </Text>
      ) : null}
      {expanded && load.uri ? (
        <MobileImageViewer
          uri={load.uri}
          label={label}
          actions={MobileImageViewerActions}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  frame: { gap: spacing.xs },
  imageButton: { alignSelf: 'flex-start', maxWidth: '100%' },
  caption: { color: colors.textSecondary, fontSize: typography.metaSize }
}))
