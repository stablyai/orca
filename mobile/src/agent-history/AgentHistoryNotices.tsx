import { useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { TriangleAlert } from 'lucide-react-native'
import { colors, radii, spacing, typography, pressedStyle } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { AgentHistoryRestartOffer } from './use-agent-history-restart-offer'
import { AutoHeight, Presence } from '../components/motion/AutoHeight'
import { HostRouteNoticeBanner } from '../components/host-connection/HostRouteNoticeBanner'
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
  message: string | null
  onDismiss: () => void
}) {
  return (
    <Presence>
      {message ? <HostRouteNoticeBanner message={message} onDismiss={onDismiss} /> : null}
    </Presence>
  )
}

/** Desktop's resume-after-restart offer, as the phone's notice strip: "3 chats were interrupted · Resume all". */
export function AgentHistoryInterruptedNotice({ offer }: { offer: AgentHistoryRestartOffer }) {
  const t = useMobileTranslation()
  const { count, failedCount, requestFailed, resuming } = offer
  const shown = count > 0 || failedCount > 0 || requestFailed
  const message = requestFailed
    ? t('agentHistory.interrupted.failed', "Couldn't resume the interrupted chats.")
    : count > 0
      ? count === 1
        ? t('agentHistory.interrupted.count_one', '{{count}} chat was interrupted', { count })
        : t('agentHistory.interrupted.count_other', '{{count}} chats were interrupted', { count })
      : failedCount === 1
        ? t('agentHistory.interrupted.failedCount_one', "{{count}} chat couldn't resume", {
            count: failedCount
          })
        : t('agentHistory.interrupted.failedCount_other', "{{count}} chats couldn't resume", {
            count: failedCount
          })
  const action =
    !resuming && (count > 0 || requestFailed)
      ? {
          label: requestFailed
            ? t('common.retry', 'Retry')
            : t('agentHistory.interrupted.resumeAll', 'Resume all'),
          onPress: offer.resumeAll
        }
      : undefined
  return (
    <Presence>
      {shown ? (
        <HostRouteNoticeBanner
          message={message}
          leading={
            resuming ? <ActivityIndicator size="small" color={colors.textSecondary} /> : undefined
          }
          action={action}
          onDismiss={offer.dismiss}
        />
      ) : null}
    </Presence>
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
