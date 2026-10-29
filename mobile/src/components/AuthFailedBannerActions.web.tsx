import { Pressable, Text } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { authFailedBannerStyles as styles } from './auth-failed-banner-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

// Offer shell-routed /pair-scan only; web forceReconnect is null and page-host-removal-refusal rejects Remove, so direct users to app for both.
export function AuthFailedBannerActions({
  onRepair
}: {
  canRetry: boolean
  onRetry: () => void
  onRepair: () => void
  onRemove: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <>
      <Pressable style={styles.action} onPress={onRepair}>
        <Text style={styles.actionText}>
          {t('components.authFailedBannerActions.repair', 'Re-pair')}
        </Text>
      </Pressable>
      <Text style={styles.note}>
        {t(
          'components.authFailedBannerActions.webNote',
          'Reconnect or remove this host from the Orca app.'
        )}
      </Text>
    </>
  )
}
