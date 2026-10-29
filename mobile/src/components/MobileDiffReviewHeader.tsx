import { FlatList, Pressable, Text, View } from 'react-native'
import { ChevronLeft, ListChecks, MoreHorizontal } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { MobileDiffReviewQueueFilter } from '../session/mobile-diff-review-queue'
import { REVIEW_FILTERS } from '../session/mobile-diff-review-screen-model'
import { shouldShowTrigger } from './mobile-pr-sidebar-presentation'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'

type Props = {
  filter: MobileDiffReviewQueueFilter
  isWideLayout: boolean
  prSidebarIsGithubRepo: boolean
  prSidebarCanDock: boolean
  queueLength: number
  reviewedCount: number
  unsentCount: number
  worktreeLabel: string
  onBack: () => void
  onOpenActions: () => void
  onOpenPRSidebar: () => void
  onSelectFilter: (filter: MobileDiffReviewQueueFilter) => void
}

export function MobileDiffReviewHeader({
  filter,
  isWideLayout,
  prSidebarIsGithubRepo,
  prSidebarCanDock,
  queueLength,
  reviewedCount,
  unsentCount,
  worktreeLabel,
  onBack,
  onOpenActions,
  onOpenPRSidebar,
  onSelectFilter
}: Props) {
  const t = useMobileTranslation()
  const colorScheme = useMobileColorScheme()
  const count = unsentCount
  const filters: Record<
    MobileDiffReviewQueueFilter,
    { label: string; accessibilityLabel: string }
  > = {
    all: {
      label: t('components.diffReviewHeader.filterAll', 'All'),
      accessibilityLabel: t('components.diffReviewHeader.showAllFiles', 'Show all review files')
    },
    unreviewed: {
      label: t('components.diffReviewHeader.filterUnreviewed', 'Unreviewed'),
      accessibilityLabel: t(
        'components.diffReviewHeader.showUnreviewedFiles',
        'Show unreviewed review files'
      )
    },
    notes: {
      label: t('components.diffReviewHeader.filterNotes', 'Notes'),
      accessibilityLabel: t('components.diffReviewHeader.showNotesFiles', 'Show notes review files')
    },
    unstaged: {
      label: t('components.diffReviewHeader.filterUnstaged', 'Unstaged'),
      accessibilityLabel: t(
        'components.diffReviewHeader.showUnstagedFiles',
        'Show unstaged review files'
      )
    },
    staged: {
      label: t('components.diffReviewHeader.filterStaged', 'Staged'),
      accessibilityLabel: t(
        'components.diffReviewHeader.showStagedFiles',
        'Show staged review files'
      )
    },
    branch: {
      label: t('components.diffReviewHeader.filterBranch', 'Branch'),
      accessibilityLabel: t(
        'components.diffReviewHeader.showBranchFiles',
        'Show branch review files'
      )
    }
  }
  // Show PR icon on narrow/overlay GitHub repos; wide docked sidebar needs no trigger.
  const showPRTrigger = shouldShowTrigger({
    isGithubRepo: prSidebarIsGithubRepo,
    isWideLayout,
    canDock: prSidebarCanDock
  })
  return (
    <View style={styles.header}>
      <View style={styles.topBar}>
        <Pressable
          style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
        >
          <ChevronLeft size={19} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
        <View style={styles.titleBlock}>
          <Text style={styles.title} numberOfLines={1}>
            {t('components.diffReviewHeader.title', 'Changes')}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {worktreeLabel}
          </Text>
        </View>
        {showPRTrigger ? (
          <Pressable
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
            onPress={onOpenPRSidebar}
            accessibilityRole="button"
            accessibilityLabel={t(
              'components.diffReviewHeader.openPullRequestSidebar',
              'Open pull request sidebar'
            )}
          >
            <ListChecks size={19} color={colors.textPrimary} strokeWidth={2.2} />
          </Pressable>
        ) : null}
        <Pressable
          style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
          onPress={onOpenActions}
          accessibilityRole="button"
          accessibilityLabel={t(
            'components.diffReviewHeader.openReviewActions',
            'Open review actions'
          )}
        >
          <MoreHorizontal size={19} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      </View>
      <View style={styles.progressRow}>
        <Text style={styles.progressText}>
          {t(
            'components.diffReviewHeader.reviewedProgress',
            '{{reviewedCount}}/{{queueLength}} reviewed',
            {
              reviewedCount,
              queueLength
            }
          )}
        </Text>
        <Text style={styles.progressText}>
          {count === 1
            ? t('components.diffReviewHeader.unsentNotes_one', '{{count}} unsent note', { count })
            : t('components.diffReviewHeader.unsentNotes_other', '{{count}} unsent notes', {
                count
              })}
        </Text>
      </View>
      <FlatList
        data={REVIEW_FILTERS}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item}
        extraData={[colorScheme, t]}
        contentContainerStyle={styles.filterRow}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [
              styles.filterChip,
              filter === item && styles.filterChipActive,
              pressed && styles.filterChipPressed
            ]}
            onPress={() => onSelectFilter(item)}
            accessibilityRole="button"
            accessibilityState={{ selected: filter === item }}
            accessibilityLabel={filters[item].accessibilityLabel}
          >
            <Text style={[styles.filterText, filter === item && styles.filterTextActive]}>
              {filters[item].label}
            </Text>
          </Pressable>
        )}
      />
    </View>
  )
}
