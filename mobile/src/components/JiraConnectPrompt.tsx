import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { TaskProviderLogo } from './TaskProviderLogo'

type Props = {
  credentialError: string | null
  disabled: boolean
  onCheckAgain: () => void
}

// Why: connecting Jira needs a site URL, email, and API token — a form that belongs
// on desktop, so mobile points there instead of half-hosting it. This renders
// outside the task list, so there is no pull-to-refresh; the only way forward is an
// explicit re-check of jira.status.
export function JiraConnectPrompt({ credentialError, disabled, onCheckAgain }: Props) {
  return (
    <View style={styles.centered}>
      <TaskProviderLogo provider="jira" size={32} color={colors.textSecondary} />
      <Text style={styles.emptyText}>Connect Jira on your desktop</Text>
      <Text style={styles.centeredHint}>
        {credentialError
          ? `Jira is saved but unreadable: ${credentialError}`
          : 'Add your Jira site in Orca desktop under Settings → Integrations, then check again.'}
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
        <Text style={styles.checkAgainText}>Check again</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
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
})
