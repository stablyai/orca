import { useMemo, useRef } from 'react'
import { Pressable, Text, View, type FlatList } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft, ChevronRight } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { shortGitHash } from '../../../src/shared/git-history-log-parser'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { MobileDiffReviewBody } from '../components/MobileDiffReviewBody'
import { mobileDiffReviewStyles as reviewStyles } from '../components/mobile-diff-review-screen-styles'
import type { ReviewDiffLine } from '../session/mobile-diff-review-screen-model'
import { styles as hubStyles } from './mobile-source-control-styles'
import { useMobileCommitDiff } from './use-mobile-commit-diff'

const NO_COMMENTS = new Map()
const NO_STALE_COMMENTS: ReadonlySet<string> = new Set()
const noop = () => {}

// Committed files are read-only: no notes, staging or reviewed state, only the diff and file stepping.
export function MobileCommitDiffScreen({
  hostId,
  worktreeId,
  commitId,
  initialFilePath
}: {
  hostId: string
  worktreeId: string
  commitId: string
  initialFilePath: string
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const insets = useSafeAreaInsets()
  const router = useWorkspaceRouteHandoff()
  const listRef = useRef<FlatList<ReviewDiffLine> | null>(null)
  const { client, state: connState } = useWorkspaceClient(hostId)
  const review = useMobileCommitDiff({ client, connState, worktreeId, commitId, initialFilePath })
  const fileCount = review.files?.length ?? 0
  const gate = useMemo(() => {
    if (review.files === null) {
      return review.filesError
        ? { kind: 'error' as const, message: review.filesError }
        : { kind: 'loading' as const }
    }
    return { kind: 'ready' as const }
  }, [review.files, review.filesError])
  const currentItem = review.currentKey ? { key: review.currentKey } : null

  return (
    <SafeAreaView style={hubStyles.container} edges={['top']}>
      <View style={hubStyles.topBar}>
        <Pressable
          style={({ pressed }) => [hubStyles.backButton, pressed && hubStyles.backButtonPressed]}
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
        >
          <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
        <View style={hubStyles.titleBlock}>
          <Text style={hubStyles.title} numberOfLines={1}>
            {review.currentFile?.path.split('/').pop() ??
              t('sourceControl.commitDetail.title', 'Commit')}
          </Text>
          <Text style={hubStyles.meta} numberOfLines={1}>
            <Text style={{ fontFamily: typography.monoFamily }}>{shortGitHash(commitId)}</Text>
            {fileCount > 0
              ? ` · ${t('sourceControl.commitDiff.position', '{{index}} of {{count}}', {
                  index: review.index + 1,
                  count: fileCount
                })}`
              : ''}
          </Text>
        </View>
      </View>
      <MobileDiffReviewBody
        activeHunkIndex={null}
        commentsByLine={NO_COMMENTS}
        currentItem={currentItem}
        diffState={review.diff ?? { kind: 'loading', itemKey: review.currentKey ?? '' }}
        filteredCount={fileCount}
        listRef={listRef}
        screenState={gate}
        staleCommentIds={NO_STALE_COMMENTS}
        onEditNote={noop}
        onRetry={review.files === null ? review.reloadFiles : review.reloadDiff}
      />
      {fileCount > 1 ? (
        <View style={[reviewStyles.footer, { paddingBottom: insets.bottom + spacing.sm }]}>
          <View style={reviewStyles.footerRow}>
            <Pressable
              style={({ pressed }) => [
                reviewStyles.navButton,
                pressed && reviewStyles.buttonPressed
              ]}
              onPress={() => review.move('previous')}
              accessibilityRole="button"
              accessibilityLabel={t('components.diffReviewFooter.previousFile', 'Previous file')}
            >
              <ChevronLeft size={17} color={colors.textPrimary} strokeWidth={2.2} />
            </Pressable>
            <Text style={reviewStyles.fileMeta} numberOfLines={1}>
              {review.currentFile?.path}
            </Text>
            <Pressable
              style={({ pressed }) => [
                reviewStyles.navButton,
                pressed && reviewStyles.buttonPressed
              ]}
              onPress={() => review.move('next')}
              accessibilityRole="button"
              accessibilityLabel={t('components.diffReviewFooter.nextFile', 'Next file')}
            >
              <ChevronRight size={17} color={colors.textPrimary} strokeWidth={2.2} />
            </Pressable>
          </View>
        </View>
      ) : null}
    </SafeAreaView>
  )
}
