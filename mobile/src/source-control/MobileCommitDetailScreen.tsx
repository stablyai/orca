import { useMemo, useState, type ReactNode } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft, Copy, ExternalLink, MoreHorizontal, Sparkles } from 'lucide-react-native'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/tui-agent-display-names'
import { shortGitHash } from '../../../src/shared/git-history-log-parser'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ActionSheetModal } from '../components/ActionSheetModal'
import type { MobileGitChangedFile } from './git-compare-reply-schema'
import { buildMobileCommitFileTree, type MobileCommitTreeNode } from './mobile-commit-files'
import { MobileCommitFileTreeRow } from './MobileCommitFileTreeRow'
import { CommitAvatar, CommitLineCounts } from './MobileCommitTimelineRows'
import { formatCommitDateTime } from './mobile-commit-timeline-time'
import { styles as hubStyles } from './mobile-source-control-styles'
import { commitDetailStyles as styles } from './mobile-commit-detail-styles'
import type { MobileCommitDetail } from './use-mobile-commit-detail'
import type { MobileCommitFilesState } from './use-mobile-commit-files'
import type {
  MobileCommitDetailNotice,
  MobileCommitExplainLaunch
} from './use-mobile-commit-detail-actions'
import { AgentLaunchNotice } from '../components/AgentLaunchNotice'
import type { MobileAgentLaunchAvailability } from '../session/mobile-agent-launch-availability'

type Props = {
  commitId: string
  detail: MobileCommitDetail | null
  files: MobileCommitFilesState
  connected: boolean
  notice: MobileCommitDetailNotice
  launch: MobileCommitExplainLaunch | null
  launchAvailability: MobileAgentLaunchAvailability
  explaining: boolean
  onBack: () => void
  onOpenFile: (file: MobileGitChangedFile) => void
  onReviewChanges: () => void
  onCopyMessage: () => void
  onCopySha: () => void
  onOpenRemote: () => void
  onExplain: () => void
}

function DetailRow({
  label,
  divider = true,
  children
}: {
  label: string
  divider?: boolean
  children: ReactNode
}) {
  return (
    <View style={[styles.detailRow, divider && styles.detailDivider]}>
      <Text style={styles.detailLabel}>{label}</Text>
      <View style={styles.detailValue}>{children}</View>
    </View>
  )
}

export function MobileCommitDetailScreen({
  commitId,
  detail,
  files,
  connected,
  notice,
  launch,
  launchAvailability,
  explaining,
  onBack,
  onOpenFile,
  onReviewChanges,
  onCopyMessage,
  onCopySha,
  onOpenRemote,
  onExplain
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const insets = useSafeAreaInsets()
  const [menuOpen, setMenuOpen] = useState(false)
  // "Today" means the day the page opened, like the timeline's day headers.
  const [openedAtMs] = useState(() => Date.now())
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const shortId = detail?.shortId ?? shortGitHash(commitId)
  const tree = useMemo(
    () => (files.files ? buildMobileCommitFileTree(files.files, collapsed) : []),
    [collapsed, files.files]
  )
  const totals = useMemo(
    () =>
      (files.files ?? []).reduce(
        (sum, file) => ({
          added: sum.added + (file.added ?? 0),
          removed: sum.removed + (file.removed ?? 0)
        }),
        { added: 0, removed: 0 }
      ),
    [files.files]
  )
  const fileCount = files.files?.length ?? 0
  const author = detail
    ? detail.agent
      ? detail.author && detail.agentCoAuthored
        ? t('sourceControl.commitDetail.agentWithAuthor', '{{agent}}, with {{author}}', {
            agent: TUI_AGENT_DISPLAY_NAMES[detail.agent],
            author: detail.author
          })
        : TUI_AGENT_DISPLAY_NAMES[detail.agent]
      : detail.author
    : ''

  const toggleDirectory = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) {
        next.add(key)
      }
      return next
    })

  const header = (
    <View>
      {detail ? (
        <View style={styles.message}>
          <Text style={styles.subject}>
            {detail.subject || t('sourceControl.gitHistory.noCommitMessage', '(no commit message)')}
          </Text>
          {detail.body ? <Text style={styles.body}>{detail.body}</Text> : null}
        </View>
      ) : null}
      {notice ? (
        <Text
          style={[styles.notice, notice.tone === 'error' && styles.noticeError]}
          accessibilityLiveRegion="polite"
        >
          {notice.text}
        </Text>
      ) : null}
      {launch ? (
        <View style={styles.launchNotice}>
          <AgentLaunchNotice
            availability={launchAvailability}
            success={launch.success}
            error={launch.error}
            warning={launch.warning}
            undeliveredPrompt={launch.undeliveredPrompt}
            errorStyle={styles.noticeError}
          />
        </View>
      ) : null}
      <View style={styles.group}>
        {detail && author ? (
          <DetailRow label={t('sourceControl.commitDetail.author', 'Author')} divider={false}>
            <CommitAvatar agent={detail.agent} author={detail.author} />
            <Text style={styles.detailText} numberOfLines={1}>
              {author}
            </Text>
          </DetailRow>
        ) : null}
        {detail?.timestamp != null ? (
          <DetailRow label={t('sourceControl.commitDetail.date', 'Date')} divider={Boolean(author)}>
            <Text style={styles.detailText} numberOfLines={1}>
              {formatCommitDateTime(detail.timestamp, openedAtMs)}
            </Text>
          </DetailRow>
        ) : null}
        {detail && detail.unpushed !== null ? (
          <DetailRow label={t('sourceControl.commitDetail.status', 'Status')}>
            <View style={[styles.badge, detail.unpushed && styles.badgeClear]}>
              {detail.unpushed ? <View style={styles.badgeUnpushedTint} /> : null}
              <View style={[styles.badgeDot, detail.unpushed && styles.badgeDotUnpushed]} />
              <Text style={[styles.badgeText, detail.unpushed && styles.badgeTextUnpushed]}>
                {detail.unpushed
                  ? t('sourceControl.commitTimeline.notPushed', 'Not pushed')
                  : t('sourceControl.commitTimeline.onOrigin', 'On origin')}
              </Text>
            </View>
          </DetailRow>
        ) : null}
        <DetailRow label={t('sourceControl.commitDetail.sha', 'SHA')} divider={detail !== null}>
          <Text style={[styles.detailText, styles.mono]} numberOfLines={1}>
            {commitId.slice(0, 12)}
          </Text>
          <View style={styles.spacer} />
          <Pressable
            onPress={onCopySha}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t('sourceControl.commitDetail.copySha', 'Copy commit hash')}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Copy size={16} color={colors.textMuted} strokeWidth={1.75} />
          </Pressable>
        </DetailRow>
      </View>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>
          {files.files
            ? fileCount === 1
              ? t('sourceControl.commitTimeline.files_one', '{{count}} file', { count: fileCount })
              : t('sourceControl.commitTimeline.files_other', '{{count}} files', {
                  count: fileCount
                })
            : t('sourceControl.commitDetail.files', 'Files')}
        </Text>
        <View style={styles.spacer} />
        <CommitLineCounts added={totals.added} removed={totals.removed} />
      </View>
      {files.files === null ? (
        <View style={styles.filesState}>
          {files.error ? (
            <>
              <Text style={styles.stateText}>{files.error}</Text>
              {connected ? (
                <Pressable
                  style={styles.retryButton}
                  onPress={files.reload}
                  accessibilityLabel={t(
                    'sourceControl.commitDetail.retryFiles',
                    'Retry commit files'
                  )}
                >
                  <Text style={styles.retryText}>{t('common.retry', 'Retry')}</Text>
                </Pressable>
              ) : null}
            </>
          ) : connected ? (
            <ActivityIndicator color={colors.textSecondary} />
          ) : (
            <Text style={styles.stateText}>
              {t('sourceControl.commitDetail.waitingForDesktop', 'Waiting for desktop...')}
            </Text>
          )}
        </View>
      ) : fileCount === 0 ? (
        <Text style={[styles.stateText, styles.filesState]}>
          {t('sourceControl.commitDetail.noFileChanges', 'No file changes')}
        </Text>
      ) : null}
    </View>
  )

  const renderNode = ({ item, index }: { item: MobileCommitTreeNode; index: number }) => (
    <MobileCommitFileTreeRow
      node={item}
      first={index === 0}
      last={index === tree.length - 1}
      expanded={!collapsed.has(item.key)}
      onToggleDirectory={toggleDirectory}
      onOpenFile={onOpenFile}
    />
  )

  return (
    <SafeAreaView style={hubStyles.container} edges={['top']}>
      <View style={hubStyles.topBar}>
        <Pressable
          style={({ pressed }) => [hubStyles.backButton, pressed && hubStyles.backButtonPressed]}
          onPress={onBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
        >
          <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
        <View style={hubStyles.titleBlock}>
          <Text style={hubStyles.title} numberOfLines={1}>
            {t('sourceControl.commitDetail.title', 'Commit')}
          </Text>
          <Text style={[hubStyles.meta, styles.mono]} numberOfLines={1}>
            {shortId}
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [
            hubStyles.refreshButton,
            pressed && hubStyles.refreshButtonPressed
          ]}
          onPress={() => setMenuOpen(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('sourceControl.commitDetail.moreActions', 'Commit actions')}
        >
          <MoreHorizontal size={20} color={colors.textSecondary} strokeWidth={2.1} />
        </Pressable>
      </View>
      <FlatList
        data={tree}
        keyExtractor={(node) => node.key}
        renderItem={renderNode}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom: 120 + insets.bottom }}
      />
      {fileCount > 0 ? (
        <View style={[styles.dock, { paddingBottom: 12 + insets.bottom }]}>
          <Pressable
            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
            onPress={onReviewChanges}
            accessibilityRole="button"
          >
            <Text style={styles.primaryButtonText}>
              {t('sourceControl.commitDetail.reviewChanges', 'Review Changes')}
            </Text>
          </Pressable>
        </View>
      ) : null}
      <ActionSheetModal
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        actions={[
          {
            id: 'copy-message',
            label: t('sourceControl.commitDetail.copyMessage', 'Copy commit message'),
            icon: Copy,
            disabled: !detail,
            onPress: onCopyMessage
          },
          {
            id: 'open-remote',
            label: t('sourceControl.commitDetail.openRemote', 'Open commit in browser'),
            icon: ExternalLink,
            onPress: onOpenRemote
          },
          {
            id: 'explain',
            label: t('sourceControl.commitDetail.explain', 'Explain changes'),
            icon: Sparkles,
            disabled: explaining,
            loading: explaining,
            onPress: onExplain
          }
        ]}
      />
    </SafeAreaView>
  )
}
