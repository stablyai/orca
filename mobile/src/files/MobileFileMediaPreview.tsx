import { useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { PDF_MIME_TYPE, type MobileFileMedia } from './mobile-file-media'
import { downloadMobileFileMedia, type MobileMediaSink } from './mobile-file-media-download'
import { createMobileMediaSink } from './mobile-media-preview-cache'
import { MobileMediaPlayback } from './MobileMediaPlayback'
import { MobilePdfPreview } from './MobilePdfPreview'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { formatPreviewByteLength } from './mobile-file-preview-response'
import { MobileLoadErrorState } from '../components/MobileLoadErrorState'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

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
  useMobileColorScheme()
  const t = useMobileTranslation()
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
            { worktreeId, relativePath, mimeType },
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
        <Text style={styles.stateText}>
          {t('files.fileMediaPreview.waiting', 'Waiting for desktop...')}
        </Text>
      </View>
    )
  }
  if ('uri' in state) {
    return <MobileMediaPlayback key={state.uri} uri={state.uri} mimeType={mimeType} title={title} />
  }
  if ('error' in state) {
    return <MobileLoadErrorState message={state.error} onRetry={() => setAttempt(attempt + 1)} />
  }
  return (
    <View style={styles.state}>
      <ActivityIndicator color={colors.textSecondary} />
      <Text style={styles.stateText}>
        {state.total
          ? t('files.fileMediaPreview.downloading', 'Downloading {{bytes}} of {{total}}', {
              bytes: formatPreviewByteLength(state.bytes),
              total: formatPreviewByteLength(state.total)
            })
          : t('files.fileMediaPreview.loading', 'Loading media...')}
      </Text>
    </View>
  )
}
