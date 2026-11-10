import type { ConnectionLogEntry } from '../diagnostics/connection/connection-log-types'
import { ConnectionLog } from '../components/ConnectionLog'
import { View, Text, Pressable } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { pairScanStyles as styles } from '../pair-scan-styles'
import { pressedStyle } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export function PairScanRecovery({
  errorMessage,
  logs,
  onConfigure,
  onRetry,
  onPaste
}: {
  errorMessage: string
  logs: ConnectionLogEntry[]
  onConfigure?: () => void
  onRetry: () => void
  onPaste: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.centered}>
      <Text style={styles.errorText}>{errorMessage}</Text>
      {logs.length > 0 && (
        <View style={styles.logSlot}>
          <ConnectionLog entries={logs} title={t('app.pairScan.pairingLog', 'Pairing log')} />
        </View>
      )}
      <View style={styles.errorActions}>
        {onConfigure ? (
          <Pressable
            style={styles.secondaryButton}
            accessibilityRole="button"
            accessibilityLabel={t('edgeAuth.configure', 'Configure edge authentication')}
            onPress={onConfigure}
          >
            <Text style={styles.secondaryButtonText}>
              {t('edgeAuth.configure', 'Configure edge authentication')}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          style={({ pressed }) => [styles.primaryButton, pressed && pressedStyle]}
          onPress={onRetry}
        >
          <Text style={styles.primaryButtonText}>{t('app.pairScan.tryAgain', 'Try Again')}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pasteButtonPressed]}
          onPress={onPaste}
        >
          <Text style={styles.secondaryButtonText}>
            {t('app.pairScan.pasteInstead', 'Paste code instead')}
          </Text>
        </Pressable>
      </View>
    </View>
  )
}
