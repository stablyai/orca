import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import {
  BottomDrawer,
  View,
  TaskProviderLogo,
  colors,
  Text,
  Pressable,
  RefreshCw
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import { taskKindLabel } from './mobile-tasks-legacy-foundation'
import { renderMobileTasksItemDetailContent } from './mobile-tasks-item-detail-content'
import { renderMobileTasksItemActions } from './mobile-tasks-item-actions'

export function renderMobileTasksItemDetailDrawer(model: ConnectionPresentationModel) {
  const { actionItem, detailLoading, taskDetailHandoff, setDetailRefreshSeq, taskUiReady } = model
  return (
    <BottomDrawer visible={taskUiReady && actionItem != null} {...taskDetailHandoff.drawerProps}>
      {actionItem ? (
        <View>
          <View style={styles.sheetHeader}>
            <View style={styles.sheetTitleRow}>
              <TaskProviderLogo
                provider={actionItem.provider}
                size={16}
                color={colors.textPrimary}
              />
              <Text style={styles.sheetTitle} numberOfLines={2}>
                {actionItem.title}
              </Text>
              <Pressable
                style={styles.iconButton}
                disabled={detailLoading}
                accessibilityLabel={translate(
                  'tasks.itemDetailDrawer.refreshDetails',
                  'Refresh details'
                )}
                onPress={() => setDetailRefreshSeq((current) => current + 1)}
              >
                <RefreshCw
                  size={16}
                  color={detailLoading ? colors.textMuted : colors.textSecondary}
                />
              </Pressable>
            </View>
            <Text style={styles.sheetSubtitle}>
              {taskKindLabel(actionItem)} · {actionItem.subtitle}
            </Text>
          </View>

          <View style={styles.detailGroup}>{renderMobileTasksItemDetailContent(model)}</View>

          {renderMobileTasksItemActions(model)}
        </View>
      ) : null}
    </BottomDrawer>
  )
}
