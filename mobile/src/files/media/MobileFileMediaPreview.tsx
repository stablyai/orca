import { useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import type { MobileFilePreviewRpcSender } from '../preview/mobile-file-preview-operations'
import { PDF_MIME_TYPE, type MobileFileMedia } from './mobile-file-media'
import { downloadMobileFileMedia, type MobileMediaSink } from './mobile-file-media-download'
import { createMobileMediaSink } from './mobile-media-preview-cache'
import { MobileMediaPlayback } from './MobileMediaPlayback'
import { MobilePdfPreview } from './MobilePdfPreview'
import { filePreviewStylesSheet } from '../preview/mobile-file-preview-styles'
import { formatPreviewByteLength } from '../preview/mobile-file-preview-response'
import { MobileLoadErrorState } from '../../components/feedback/MobileStateView'
import { translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation, useMobileUiLocale } from '../../i18n/use-mobile-translation'
import { useThemedStyles } from '../../theme/themed-styles'

type State = { uri: string } | { error: string } | { bytes: number; total: number }
type Props = { media: MobileFileMedia; client: MobileFilePreviewRpcSender | null; title: string }

export function MobileFileMediaPreview(props: Props) {
  const { worktreeId, relativePath, mimeType } = props.media
  const key = JSON.stringify([worktreeId, relativePath, mimeType])
  return mimeType === PDF_MIME_TYPE ? (
    <MobilePdfPreview key={key} media={props.media} />
  ) : (
    <MediaDownload key={key} {...props} />
  )
}

function MediaDownload({ media, client, title }: Props) {
  const styles = useThemedStyles(filePreviewStylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const locale = useMobileUiLocale()
  const { worktreeId, relativePath, mimeType } = media
  const [state, setState] = useState<State>({ bytes: 0, total: 0 })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let sink: MobileMediaSink | null = null
    setState({ bytes: 0, total: 0 })
    if (client) {
      void (async () => {
        try {
          sink = createMobileMediaSink(relativePath, mimeType)
          const uri = await downloadMobileFileMedia(
            client,
            { worktreeId, relativePath },
            sink,
            controller.signal,
            (bytes, total) => setState({ bytes, total })
          )
          if (!controller.signal.aborted) {
            setState({ uri })
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            setState({
              error:
                error instanceof Error
                  ? error.message
                  : translate('files.fileMediaPreview.loadFailed', 'Unable to load media')
            })
          }
        }
      })()
    }
    return () => {
      controller.abort()
      sink?.dispose()
    }
  }, [client, worktreeId, relativePath, mimeType, attempt])
  if (!client) {
    return (
      <View style={styles.state}>
        <Text style={styles.stateText}>{t('common.waitingForHost', 'Waiting for host…')}</Text>
      </View>
    )
  }
  if ('uri' in state) {
    return <MobileMediaPlayback key={state.uri} uri={state.uri} mimeType={mimeType} title={title} />
  }
  if ('error' in state) {
    return <MobileLoadErrorState error={state.error} onRetry={() => setAttempt(attempt + 1)} />
  }
  return (
    <View style={styles.state}>
      <ActivityIndicator color={colors.textSecondary} />
      <Text style={styles.stateText}>
        {state.total
          ? t('files.fileMediaPreview.downloading', 'Downloading {{bytes}} of {{total}}', {
              bytes: formatPreviewByteLength(state.bytes, t, locale),
              total: formatPreviewByteLength(state.total, t, locale)
            })
          : t('files.fileMediaPreview.loading', 'Loading media...')}
      </Text>
    </View>
  )
}
