import { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Pressable, ScrollView, Text, View } from 'react-native'
import { mobileSessionReviewCommentStyles } from '../session/mobile-session-review-comment-styles'
import { TriangleAlert, X } from 'lucide-react-native'
import { colors, radii, spacing, typography, pressedStyle } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { AutoHeight } from '../components/AutoHeight'
import type { AiVaultScanIssue } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import {
  aiVaultScanIssueKey,
  aiVaultScanNoticeIssues,
  blockingAiVaultScanIssue,
  skippedAiVaultTranscriptIssues
} from '../../../src/shared/ai-vault/scanning/ai-vault-scan-issue-state'

// Many skipped transcripts scroll inside the notice instead of pushing the list off screen.
const ISSUE_LIST_MAX_HEIGHT = 160

/** Splits scan issues like desktop History: host/scope/notice rows keep their own text; only kind-less ones count as skipped. */
export function AgentHistoryScanNotices({
  sessions,
  issues
}: {
  sessions: readonly unknown[]
  issues: readonly AiVaultScanIssue[]
}) {
  useMobileColorScheme()
  const scan = { sessions, issues }
  const blocking = blockingAiVaultScanIssue(scan)
  const notices = aiVaultScanNoticeIssues(scan)
  const skipped = skippedAiVaultTranscriptIssues(scan)
  return (
    <>
      {blocking ? (
        <View style={styles.notice}>
          <Text style={styles.hostIssueText}>{blocking.message}</Text>
        </View>
      ) : null}
      {notices.length > 0 ? (
        <View style={styles.notice}>
          <AutoHeight maxHeight={ISSUE_LIST_MAX_HEIGHT}>
            <ScrollView contentContainerStyle={styles.noticeList} nestedScrollEnabled>
              {notices.map((issue) => (
                <Text
                  key={aiVaultScanIssueKey(issue)}
                  style={issue.kind === 'host' ? styles.hostIssueText : styles.noticeText}
                >
                  {issue.message}
                </Text>
              ))}
            </ScrollView>
          </AutoHeight>
        </View>
      ) : null}
      {skipped.length > 0 ? <AgentHistorySkippedNotice issues={skipped} /> : null}
    </>
  )
}

/** Says how many transcripts the scan skipped, with the paths and reasons one tap away. */
function AgentHistorySkippedNotice({ issues }: { issues: readonly AiVaultScanIssue[] }) {
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
          style={({ pressed }) => pressed && pressedStyle}
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
              <View key={aiVaultScanIssueKey(issue)} style={styles.issue}>
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
        style={({ pressed }) => pressed && pressedStyle}
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
  hostIssueText: {
    color: colors.statusRed,
    fontSize: 13
  },
  noticeList: {
    gap: spacing.sm
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
export function useAgentHistoryResumeToast() {
  const [message, setMessage] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const showToast = useCallback((text: string) => {
    clearTimeout(timer.current)
    setMessage(text)
    // The toast has no focus or live region, so announce it on both platforms.
    AccessibilityInfo.announceForAccessibility(text)
    timer.current = setTimeout(() => setMessage(null), 3_000)
  }, [])
  return { message, showToast }
}

export function AgentHistoryResumeToast({
  message,
  bottomInset
}: {
  message: string | null
  bottomInset: number
}) {
  useMobileColorScheme()
  return message ? (
    <View
      pointerEvents="none"
      style={[mobileSessionReviewCommentStyles.toast, { bottom: bottomInset + spacing.lg }]}
    >
      <Text style={mobileSessionReviewCommentStyles.toastText}>{message}</Text>
    </View>
  ) : null
}
