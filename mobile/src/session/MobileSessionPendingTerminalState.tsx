import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-session-styles'

export function MobileSessionPendingTerminalState({
  title,
  parked,
  onRetry
}: {
  title: string | undefined
  parked: boolean
  onRetry: () => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  return (
    <View style={styles.emptyState}>
      {!parked && <ActivityIndicator size="small" color={colors.textSecondary} />}
      <Text style={styles.emptyText}>
        {parked
          ? t(
              'session.activeContent.terminalTakingLonger',
              'Terminal is taking longer than expected'
            )
          : title || t('session.activeContent.loadingTerminal', 'Loading terminal')}
      </Text>
      {parked && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(
            'session.activeContent.retryLoadingTerminal',
            'Retry loading terminal'
          )}
          style={({ pressed }) => [styles.createButton, pressed && styles.newTerminalButtonPressed]}
          onPress={onRetry}
        >
          <Text style={styles.createButtonText}>{t('common.retry', 'Retry')}</Text>
        </Pressable>
      )}
    </View>
  )
}
