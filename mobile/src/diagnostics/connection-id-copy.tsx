import { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { pressedStyle } from '../theme/mobile-theme'
import { connectionDiagnosticsScreenStyles as styles } from './connection-diagnostics-screen-styles'

type Props = {
  hostId: string | null
  writeClipboard: (value: string) => Promise<unknown>
}

export function ConnectionIdCopy({ hostId, writeClipboard }: Props) {
  return hostId ? (
    <SelectedConnectionIdCopy key={hostId} hostId={hostId} writeClipboard={writeClipboard} />
  ) : null
}

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

  const copy = async () => {
    if (pending.current) {
      return
    }
    pending.current = true
    setStatus('copying')
    try {
      await writeClipboard(hostId)
      if (mounted.current) {
        setStatus('copied')
      }
    } catch {
      if (mounted.current) {
        setStatus('failed')
      }
    } finally {
      pending.current = false
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
