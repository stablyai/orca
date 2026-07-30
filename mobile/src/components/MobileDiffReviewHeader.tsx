import { FlatList, Pressable, Text, View } from 'react-native'
import { ChevronLeft, ListChecks, MoreHorizontal } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import type { MobileDiffReviewQueueFilter } from '../session/mobile-diff-review-queue'
import {
  REVIEW_FILTERS,
  mobileReviewFilterLabel,
  mobileReviewUnsentNoteCountLabel
} from '../session/mobile-diff-review-screen-model'
import { shouldShowTrigger } from './mobile-pr-sidebar-presentation'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'
import { t } from '@/i18n/mobile-i18n'

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
  // The dedicated PR icon appears on any GitHub repo in narrow/overlay mode; in wide
  // mode the sidebar is docked, so it is hidden (not disabled).
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
          accessibilityLabel={t('m.Xot6WdE')}
        >
          <ChevronLeft size={19} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
        <View style={styles.titleBlock}>
          <Text style={styles.title} numberOfLines={1}>
            {t('m.1lIaLfU')}
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
            accessibilityLabel={t('m.GAXIVbU')}
          >
            <ListChecks size={19} color={colors.textPrimary} strokeWidth={2.2} />
          </Pressable>
        ) : null}
        <Pressable
          style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
          onPress={onOpenActions}
          accessibilityRole="button"
          accessibilityLabel={t('m.LU8BxDQ')}
        >
          <MoreHorizontal size={19} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      </View>
      <View style={styles.progressRow}>
        <Text style={styles.progressText}>
          {t('m.fEoGCmQ', { value0: reviewedCount, value1: queueLength })}
        </Text>
        <Text style={styles.progressText}>{mobileReviewUnsentNoteCountLabel(unsentCount)}</Text>
      </View>
      <FlatList
        data={REVIEW_FILTERS}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item}
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
            accessibilityLabel={t('m.qcWQKWI', { value0: mobileReviewFilterLabel(item) })}
          >
            <Text style={[styles.filterText, filter === item && styles.filterTextActive]}>
              {mobileReviewFilterLabel(item)}
            </Text>
          </Pressable>
        )}
      />
    </View>
  )
}
