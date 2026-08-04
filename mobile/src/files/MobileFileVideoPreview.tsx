import { useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { useEvent } from 'expo'
import { useVideoPlayer, VideoView } from 'expo-video'
import { colors } from '../theme/mobile-theme'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import {
  deleteMobileVideoPreviewFile,
  mobileVideoPreviewFileName,
  writeMobileVideoPreviewFile
} from './mobile-video-preview-cache-file'

type Props = {
  relativePath: string
  base64: string
  mimeType: string
  title: string
}

// Plays a video the host returned as base64 (files.readPreview). The bytes are
// staged in the cache directory because the native players cannot open a data URI.
export function MobileFileVideoPreview({ relativePath, base64, mimeType, title }: Props) {
  const [stagedUri, setStagedUri] = useState<string | null>(null)
  const [stageError, setStageError] = useState('')

  useEffect(() => {
    let staged: string | null = null
    try {
      staged = writeMobileVideoPreviewFile(
        mobileVideoPreviewFileName(relativePath, mimeType),
        base64
      )
      setStageError('')
      setStagedUri(staged)
    } catch (err) {
      setStagedUri(null)
      setStageError(err instanceof Error ? err.message : 'Unable to open this video')
    }
    return () => {
      setStagedUri(null)
      if (staged) {
        deleteMobileVideoPreviewFile(staged)
      }
    }
  }, [base64, mimeType, relativePath])

  const player = useVideoPlayer(stagedUri, (instance) => {
    instance.loop = false
  })
  const statusChange = useEvent(player, 'statusChange')
  const status = statusChange?.status ?? player.status

  if (stageError || status === 'error') {
    return (
      <View style={styles.state}>
        <Text style={styles.errorText}>
          {stageError || statusChange?.error?.message || 'Unable to play this video'}
        </Text>
      </View>
    )
  }

  return (
    <View style={styles.videoContainer}>
      <VideoView
        style={styles.video}
        player={player}
        contentFit="contain"
        accessibilityLabel={`${title} video`}
      />
      {status === 'readyToPlay' ? null : (
        <View style={styles.videoLoading} pointerEvents="none">
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      )}
    </View>
  )
}
