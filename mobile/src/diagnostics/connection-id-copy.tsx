import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Platform, Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { pressedStyle } from '../theme/mobile-theme'
import { connectionDiagnosticsScreenStyles as styles } from './connection-diagnostics-screen-styles'

type Props = {
  hostId: string | null
  writeClipboard: (value: string) => Promise<unknown>
}

/** Key feedback to the selected connection so pending writes cannot outlive their host. */
export function ConnectionIdCopy({ hostId, writeClipboard }: Props) {
  return hostId ? (
    <SelectedConnectionIdCopy key={hostId} hostId={hostId} writeClipboard={writeClipboard} />
  ) : null
}

/** Keep clipboard feedback and announcements scoped to this connection's lifetime. */
function SelectedConnectionIdCopy({ hostId, writeClipboard }: Props & { hostId: string }) {
  const t = useMobileTranslation()
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /** Announce settled clipboard results only while their connection is still selected. */
  const copy = async () => {
    if (pending.current) {
      return
    }
    pending.current = true
    setStatus('copying')
    let result: 'copied' | 'failed' = 'copied'
    try {
      await writeClipboard(hostId)
    } catch {
      result = 'failed'
    } finally {
      pending.current = false
    }
    if (!mounted.current) {
      return
    }
    setStatus(result)
    if (Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(
        result === 'copied'
          ? t('diagnostics.connectionIdCopy.copied', 'Connection ID copied')
          : t('diagnostics.connectionIdCopy.failed', 'Could not copy. Try again.')
      )
    }
  }

  return (
    <View style={styles.diagnosisCard}>
      <Text style={styles.diagnosisHeading}>
        {t('diagnostics.connectionIdCopy.title', 'Connection ID')}
      </Text>
      <Text selectable style={styles.diagnosisText}>
        {hostId}
      </Text>
      <Pressable
        testID="copy-connection-id"
        accessibilityRole="button"
        accessibilityState={{ disabled: status === 'copying', busy: status === 'copying' }}
        disabled={status === 'copying'}
        onPress={() => void copy()}
        style={({ pressed }) => [styles.sendButton, pressed && pressedStyle]}
      >
        <Text style={styles.copyButtonText}>
          {t('diagnostics.connectionIdCopy.copy', 'Copy connection ID')}
        </Text>
      </Pressable>
      {status === 'copied' && (
        <Text accessibilityLiveRegion="polite" style={styles.diagnosisNext}>
          {t('diagnostics.connectionIdCopy.copied', 'Connection ID copied')}
        </Text>
      )}
      {status === 'failed' && (
        <Text accessibilityLiveRegion="polite" style={styles.diagnosisNext}>
          {t('diagnostics.connectionIdCopy.failed', 'Could not copy. Try again.')}
        </Text>
      )}
    </View>
  )
}
