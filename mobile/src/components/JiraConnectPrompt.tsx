import { Pressable, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { TaskProviderLogo } from './TaskProviderLogo'

type Props = {
  credentialError: string | null
  unavailableReason: string | null
  disabled: boolean
  onCheckAgain: () => void
}

// Jira credentials are managed on the paired desktop.
export function JiraConnectPrompt({
  credentialError,
  unavailableReason,
  disabled,
  onCheckAgain
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.centered}>
      <TaskProviderLogo provider="jira" size={32} color={colors.textSecondary} />
      <Text style={styles.emptyText}>
        {unavailableReason
          ? t('components.jiraConnectPrompt.updateDesktop', 'Update Orca desktop')
          : t('components.jiraConnectPrompt.connectOnDesktop', 'Connect Jira on your desktop')}
      </Text>
      <Text style={styles.centeredHint}>
        {unavailableReason ??
          (credentialError
            ? t(
                'components.jiraConnectPrompt.credentialUnreadable',
                'Jira is saved but unreadable: {{credentialError}}',
                { credentialError }
              )
            : t(
                'components.jiraConnectPrompt.connectHint',
                'Add your Jira site in Orca desktop under Settings → Integrations, then check again.'
              ))}
      </Text>
      <Pressable
        style={styles.checkAgainButton}
        disabled={disabled}
        onPress={() => {
          if (!disabled) {
            onCheckAgain()
          }
        }}
      >
        <Text style={styles.checkAgainText}>
          {t('components.jiraConnectPrompt.checkAgain', 'Check again')}
        </Text>
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  centeredHint: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.sm,
    maxWidth: 280,
    textAlign: 'center'
  },
  checkAgainButton: {
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    marginTop: spacing.md,
    minWidth: 160
  },
  checkAgainText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize
  }
}))
