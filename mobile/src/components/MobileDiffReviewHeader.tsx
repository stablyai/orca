import { ScrollView, View } from 'react-native'
import { GitPullRequest, MoreHorizontal } from 'lucide-react-native'
import type { MobileDiffReviewQueueFilter } from '../session/mobile-diff-review-queue'
import { REVIEW_FILTERS } from '../session/mobile-diff-review-screen-model'
import { triggerSelection } from '../platform/haptics'
import { shouldShowTrigger } from './mobile-pr-sidebar-presentation'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'
import { FilterChip } from './ui/FilterChip'
import { IconButton } from './ui/IconButton'
import { NavBar } from './ui/NavBar'

type Props = {
  filter: MobileDiffReviewQueueFilter
  isWideLayout: boolean
  prSidebarIsGithubRepo: boolean
  prSidebarCanDock: boolean
  queueLength: number
  reviewedCount: number
  unsentCount: number
  worktreeLabel: string
  /** The file under review; the bar falls back to "Review" when there is none. */
  fileName?: string
  onBack: () => void
  onOpenActions: () => void
  onOpenPRSidebar: () => void
  onSelectFilter: (filter: MobileDiffReviewQueueFilter) => void
}

const FILTER_LABELS: Record<MobileDiffReviewQueueFilter, string> = {
  all: 'All',
  unreviewed: 'Unreviewed',
  notes: 'Notes',
  unstaged: 'Unstaged',
  staged: 'Staged',
  branch: 'Branch'
}

export function MobileDiffReviewHeader({
  filter,
  isWideLayout,
  prSidebarIsGithubRepo,
  prSidebarCanDock,
  queueLength,
  reviewedCount,
  worktreeLabel,
  fileName,
  onBack,
  onOpenActions,
  onOpenPRSidebar,
  onSelectFilter
}: Props) {
  // The dedicated PR icon appears on any GitHub repo in narrow/overlay mode; in wide
  // mode the sidebar is docked, so it is hidden (not disabled).
  const showPRTrigger = shouldShowTrigger({
    isGithubRepo: prSidebarIsGithubRepo,
    isWideLayout,
    canDock: prSidebarCanDock
  })
  const progress =
    queueLength > 0 ? `${reviewedCount} of ${queueLength} reviewed` : worktreeLabel || undefined
  return (
    <View>
      <NavBar
        title={fileName ?? 'Review'}
        subtitle={progress}
        onBack={onBack}
        trailing={
          <>
            {showPRTrigger ? (
              <IconButton
                icon={GitPullRequest}
                accessibilityLabel="Open pull request sidebar"
                onPress={onOpenPRSidebar}
                variant="bare"
              />
            ) : null}
            <IconButton
              icon={MoreHorizontal}
              accessibilityLabel="Open review actions"
              onPress={onOpenActions}
            />
          </>
        }
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
      >
        {REVIEW_FILTERS.map((item) => (
          <FilterChip
            key={item}
            label={FILTER_LABELS[item]}
            active={filter === item}
            onPress={() => {
              if (filter !== item) {
                triggerSelection()
              }
              onSelectFilter(item)
            }}
            accessibilityLabel={`Show ${item} review files`}
          />
        ))}
      </ScrollView>
    </View>
  )
}
