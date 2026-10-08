import { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import type { MobileMediaPlaybackProps } from './MobileMediaPlayback'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

export function MobileMediaPlayback({ uri, mimeType, title }: MobileMediaPlaybackProps) {
  const mediaRef = useRef<HTMLMediaElement>(null)
  const [failure, setFailure] = useState('')
  useEffect(() => {
    const blockedMedia = (event: SecurityPolicyViolationEvent): void => {
      if (event.effectiveDirective === 'media-src') {
        setFailure('Update Orca Mobile to play media in this workspace')
      }
    }
    document.addEventListener('securitypolicyviolation', blockedMedia)
    const media = mediaRef.current
    if (media) {
      media.src = uri
    }
    return () => {
      document.removeEventListener('securitypolicyviolation', blockedMedia)
      if (media) {
        media.pause()
        media.removeAttribute('src')
        media.load()
      }
    }
  }, [uri])
  if (failure) {
    return (
      <View style={styles.state}>
        <Text style={styles.errorText}>{failure}</Text>
      </View>
    )
  }
  const props = {
    src: uri,
    controls: true,
    preload: 'metadata',
    'aria-label': title,
    ref: (element: HTMLMediaElement | null): void => {
      mediaRef.current = element
    },
    onError: (): void =>
      setFailure(
        (current) =>
          current ||
          'Unable to play this media file. Its codec may not be supported on this device.'
      )
  }
  return (
    <View style={styles.state}>
      {mimeType.startsWith('audio/') ? (
        <audio {...props} style={{ width: '100%' }} />
      ) : (
        <video {...props} playsInline style={{ width: '100%', maxHeight: '100%' }} />
      )}
    </View>
  )
}
