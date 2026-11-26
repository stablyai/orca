import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { colors, spacing, typography, pressedStyle } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileLoadErrorState } from '../../components/feedback/MobileStateView'
import { styles as markdownStyles } from '../../components/markdown/mobile-markdown-styles'
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
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [load, setLoad] = useState<{ uri?: string; error?: string }>({})
  const [attempt, setAttempt] = useState(0)
  const [expanded, setExpanded] = useState(false)
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
    <View style={styles.frame}>
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
          <img
            src={load.uri}
            alt={label}
            width={width}
            style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
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

const styles = themedStyleSheet(() => ({
  frame: { gap: spacing.xs },
  imageButton: { alignSelf: 'flex-start', maxWidth: '100%' },
  caption: { color: colors.textSecondary, fontSize: typography.metaSize }
}))
