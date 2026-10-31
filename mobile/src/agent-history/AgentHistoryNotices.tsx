import { useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { TriangleAlert, X } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { AutoHeight } from '../components/AutoHeight'

type TranscriptIssue = { path: string; message: string }

// Many skipped transcripts scroll inside the notice instead of pushing the list off screen.
const ISSUE_LIST_MAX_HEIGHT = 160

/** Says how many transcripts the scan skipped, with the paths and reasons one tap away. */
export function AgentHistorySkippedNotice({ issues }: { issues: readonly TranscriptIssue[] }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [shown, setShown] = useState(false)
  const count = issues.length
  return (
    <View style={styles.notice}>
      <View style={styles.noticeRow}>
        <TriangleAlert size={14} color={colors.statusAmber} strokeWidth={2.2} />
        <Text style={styles.noticeText}>
          {count === 1
            ? t('agentHistory.panel.skipped_one', '{{count}} transcript skipped', { count })
            : t('agentHistory.panel.skipped_other', '{{count}} transcripts skipped', { count })}
        </Text>
        <Pressable
          onPress={() => setShown((value) => !value)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityState={{ expanded: shown }}
        >
          <Text style={styles.noticeAction}>
            {shown
              ? t('agentHistory.panel.hideDetails', 'Hide details')
              : t('agentHistory.panel.showDetails', 'Show details')}
          </Text>
        </Pressable>
      </View>
      <AutoHeight maxHeight={ISSUE_LIST_MAX_HEIGHT}>
        {shown ? (
          <ScrollView contentContainerStyle={styles.issueList} nestedScrollEnabled>
            {issues.map((issue) => (
              <View key={`${issue.path}\n${issue.message}`} style={styles.issue}>
                <Text style={styles.issuePath} numberOfLines={2}>
                  {issue.path}
                </Text>
                <Text style={styles.issueMessage}>{issue.message}</Text>
              </View>
            ))}
          </ScrollView>
        ) : null}
      </AutoHeight>
    </View>
  )
}

export function AgentHistoryResumeNotice({
  message,
  onDismiss
}: {
  message: string
  onDismiss: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={[styles.notice, styles.noticeRow]}>
      <Text style={styles.noticeText}>{message}</Text>
      <Pressable
        onPress={onDismiss}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={t('agentHistory.panel.dismissNotice', 'Dismiss')}
      >
        <X size={14} color={colors.textMuted} strokeWidth={2.2} />
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  notice: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.surface,
    backgroundColor: colors.bgPanel
  },
  noticeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  noticeText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 13
  },
  noticeAction: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600'
  },
  issueList: {
    marginTop: spacing.sm,
    gap: spacing.sm
  },
  issue: { gap: 2 },
  issuePath: {
    color: colors.textPrimary,
    fontSize: typography.metaSize
  },
  issueMessage: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  }
}))
