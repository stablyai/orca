import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-session-styles'

/** A terminal tab with no terminal yet: loading, slow to start, or held by a newer Orca on the computer. */
export function MobilePendingTerminalState({
  title,
  held,
  parked,
  onRetry
}: {
  title: string | undefined
  held: boolean
  parked: boolean
  onRetry: () => unknown
}): React.JSX.Element {
  const t = useMobileTranslation()
  const message = held
    ? t(
        'session.activeContent.terminalHeldByNewerVersion',
        'This terminal may still be running in a newer version of Orca on your computer. If Orca is open there, reopen it from that window; otherwise update Orca there. Then try again.'
      )
    : parked
      ? t('session.activeContent.terminalTakingLonger', 'Terminal is taking longer than expected')
      : title || t('session.activeContent.loadingTerminal', 'Loading terminal')
  return (
    <View style={styles.emptyState}>
      {!held && !parked && <ActivityIndicator size="small" color={colors.textSecondary} />}
      <Text style={styles.emptyText}>{message}</Text>
      {(held || parked) && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(
            'session.activeContent.retryLoadingTerminal',
            'Retry loading terminal'
          )}
          style={({ pressed }) => [styles.createButton, pressed && styles.newTerminalButtonPressed]}
          onPress={() => void onRetry()}
        >
          <Text style={styles.createButtonText}>{t('common.retry', 'Retry')}</Text>
        </Pressable>
      )}
    </View>
  )
}
