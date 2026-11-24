import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { translate } from '../../../i18n/mobile-i18n'
import { colors, pressedStyle } from '../../../theme/mobile-theme'
import { styles } from '../../mobile-tasks-legacy-styles'
import type { ConnectionPresentationModel } from '../../screen-state/use-mobile-tasks-connection-presentation'

/** The list's footer while the host has another page of ClickUp tasks; null once the list is complete. */
export function renderMobileTasksClickUpLoadMore(model: ConnectionPresentationModel) {
  const { clickupLoadingMore, clickupNextPage, loadMoreClickUpTasks, provider, taskUiReady } = model
  if (provider !== 'clickup' || clickupNextPage === null) {
    return undefined
  }
  return (
    <View style={styles.paginationFooter}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={translate('tasks.clickUp.loadMore', 'Load more tasks')}
        accessibilityState={{
          disabled: !taskUiReady || clickupLoadingMore,
          busy: clickupLoadingMore
        }}
        disabled={!taskUiReady || clickupLoadingMore}
        style={({ pressed }) => [styles.paginationLabelButton, pressed && pressedStyle]}
        onPress={() => void loadMoreClickUpTasks()}
      >
        {clickupLoadingMore ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <Text style={styles.paginationLabel}>
            {translate('tasks.clickUp.loadMoreLabel', 'Load more')}
          </Text>
        )}
      </Pressable>
    </View>
  )
}
