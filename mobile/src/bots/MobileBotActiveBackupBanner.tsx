// Active backup status banner with manual return-to-primary control on mobile.
import { Pressable, Text, View } from 'react-native'
import { RotateCcw } from 'lucide-react-native'
import type { BotActiveBackup } from '../../../src/shared/bots/bot-backup-models'
import { formatUsageLimitResetClock } from '../../../src/shared/agent-session/failures/agent-session-usage-limit'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsSection } from '../settings/settings-screen-frame'
import { colors, feedback, radius, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export function MobileBotActiveBackupBanner(props: {
  activeBackup: BotActiveBackup
  targetLabel: string
  primaryLabel: string
  disabled: boolean
  returning: boolean
  onReturnNow: () => void
}) {
  const t = useMobileTranslation()
  const { activeBackup, targetLabel, primaryLabel } = props
  return (
    <SettingsSection>
      <View style={styles.activeBanner}>
        <View style={styles.activeText}>
          <Text style={styles.activeTitle}>
            {t('bots.settings.backupModelsActiveBanner', 'Running on backup · {{target}}', {
              target: targetLabel
            })}
          </Text>
          <Text style={styles.activeSub}>
            {activeBackup.primaryResetsAt !== undefined
              ? t(
                  'bots.settings.backupModelsActiveReset',
                  'Returns to {{primary}} after {{time}}.',
                  {
                    primary: primaryLabel,
                    time: formatUsageLimitResetClock(activeBackup.primaryResetsAt)
                  }
                )
              : t('bots.settings.backupModelsActiveReturn', 'Returns to {{primary}} when ready.', {
                  primary: primaryLabel
                })}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          disabled={props.disabled || props.returning}
          onPress={props.onReturnNow}
          style={({ pressed }) => [
            styles.returnBtn,
            (props.disabled || props.returning) && styles.disabled,
            pressed && styles.pressed
          ]}
        >
          <RotateCcw size={14} color={colors.textPrimary} />
          <Text style={styles.returnLabel}>
            {t('bots.settings.backupModelsReturnNow', 'Return now')}
          </Text>
        </Pressable>
      </View>
    </SettingsSection>
  )
}

const styles = themedStyleSheet(() => ({
  activeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  activeText: {
    flex: 1,
    gap: 2
  },
  activeTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  activeSub: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  returnBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6
  },
  returnLabel: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '500'
  },
  disabled: {
    opacity: feedback.disabledOpacity
  },
  pressed: {
    opacity: 0.7
  }
}))
