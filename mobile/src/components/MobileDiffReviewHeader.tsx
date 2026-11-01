import { useRef, useState } from 'react'
import { ScrollView, type View } from 'react-native'
import { ChevronLeft, ListChecks, MoreHorizontal } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { MobileDiffReviewQueueFilter } from '../session/mobile-diff-review-queue'
import { REVIEW_FILTERS } from '../session/mobile-diff-review-screen-model'
import { shouldShowTrigger } from './mobile-pr-sidebar-presentation'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'
import type { ActionSheetAction } from './ActionSheetModal'
import { FilterChip } from './nav-bar/FilterChip'
import { NavBar } from './nav-bar/NavBar'
import { NavBarButton } from './nav-bar/NavBarButton'
import { PullDownMenu } from './nav-bar/PullDownMenu'

type Props = {
  /** The ⋯ menu's actions. */
  actions: ActionSheetAction[]
  filter: MobileDiffReviewQueueFilter
  isWideLayout: boolean
  prSidebarIsGithubRepo: boolean
  prSidebarCanDock: boolean
  queueLength: number
  reviewedCount: number
  unsentCount: number
  onBack: () => void
  onOpenPRSidebar: () => void
  onSelectFilter: (filter: MobileDiffReviewQueueFilter) => void
}

export function MobileDiffReviewHeader({
  actions,
  filter,
  isWideLayout,
  prSidebarIsGithubRepo,
  prSidebarCanDock,
  queueLength,
  reviewedCount,
  unsentCount,
  onBack,
  onOpenPRSidebar,
  onSelectFilter
}: Props) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const count = unsentCount
  const moreRef = useRef<View>(null)
  const [menuOpen, setMenuOpen] = useState(false)
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
  const subtitle = [
    t(
      'components.diffReviewHeader.reviewedProgress',
      '{{reviewedCount}}/{{queueLength}} reviewed',
      { reviewedCount, queueLength }
    ),
    count === 1
      ? t('components.diffReviewHeader.unsentNotes_one', '{{count}} unsent note', { count })
      : t('components.diffReviewHeader.unsentNotes_other', '{{count}} unsent notes', { count })
  ].join(' · ')
  return (
    <>
      <NavBar
        leading={
          <NavBarButton
            icon={ChevronLeft}
            onPress={onBack}
            accessibilityLabel={t('common.back', 'Back')}
          />
        }
        title={t('components.diffReviewHeader.title', 'Changes')}
        subtitle={subtitle}
        trailing={
          <>
            {showPRTrigger ? (
              <NavBarButton
                icon={ListChecks}
                onPress={onOpenPRSidebar}
                accessibilityLabel={t(
                  'components.diffReviewHeader.openPullRequestSidebar',
                  'Open pull request sidebar'
                )}
              />
            ) : null}
            <NavBarButton
              ref={moreRef}
              icon={MoreHorizontal}
              onPress={() => setMenuOpen(true)}
              active={menuOpen}
              accessibilityLabel={t(
                'components.diffReviewHeader.openReviewActions',
                'Open review actions'
              )}
            />
          </>
        }
        accessory={
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterRow}
          >
            {REVIEW_FILTERS.map((item) => (
              <FilterChip
                key={item}
                label={filters[item].label}
                active={filter === item}
                onPress={() => onSelectFilter(item)}
                accessibilityLabel={filters[item].accessibilityLabel}
              />
            ))}
          </ScrollView>
        }
      />
      <PullDownMenu
        visible={menuOpen}
        anchorRef={moreRef}
        groups={[actions]}
        onClose={() => setMenuOpen(false)}
      />
    </>
  )
}
