import { Pressable, Text } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { authFailedBannerStyles as styles } from './auth-failed-banner-styles'

// Native offers reconnect/re-pair/remove; web sibling offers only shell-routed re-pair because reconnect is null and removal refuses.
export function AuthFailedBannerActions({
  canRetry,
  onRetry,
  onRepair,
  onRemove
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
      {canRetry && (
        <Pressable style={styles.action} onPress={onRetry}>
          <Text style={styles.actionText}>{t('common.retry', 'Retry')}</Text>
        </Pressable>
      )}
      <Pressable style={styles.action} onPress={onRepair}>
        <Text style={styles.actionText}>
          {t('components.authFailedBannerActions.repair', 'Re-pair')}
        </Text>
      </Pressable>
      <Pressable style={styles.action} onPress={onRemove}>
        <Text style={[styles.actionText, { color: colors.statusRed }]}>
          {t('common.remove', 'Remove')}
        </Text>
      </Pressable>
    </>
  )
}
