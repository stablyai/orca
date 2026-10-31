import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  ActionSheetModal,
  BottomDrawer,
  View,
  TaskProviderLogo,
  colors,
  Text,
  Pressable,
  RefreshCw,
  useState
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import { taskKindLabel } from './mobile-tasks-legacy-foundation'
import { renderMobileTasksItemDetailContent } from './mobile-tasks-item-detail-content'
import {
  mobileTasksItemMenuActions,
  renderMobileTasksItemActions
} from './mobile-tasks-item-actions'

export function MobileTasksItemDetailDrawer({ model }: { model: ConnectionPresentationModel }) {
  const { actionItem, detailLoading, taskDetailHandoff, setDetailRefreshSeq, taskUiReady } = model
  const t = useMobileTranslation()
  // Keyed by item so a menu left open cannot reappear over the next item's sheet.
  const [menuItemKey, setMenuItemKey] = useState<string | null>(null)
  return (
    <>
      <BottomDrawer visible={taskUiReady && actionItem != null} {...taskDetailHandoff.drawerProps}>
        {actionItem ? (
          <View>
            <View style={styles.itemHeader}>
              <View style={styles.itemKindRow}>
                <TaskProviderLogo
                  provider={actionItem.provider}
                  size={14}
                  color={colors.textSecondary}
                />
                <Text style={styles.itemKind} numberOfLines={1}>
                  {taskKindLabel(actionItem)}
                </Text>
                <Pressable
                  style={styles.iconButton}
                  disabled={detailLoading}
                  accessibilityRole="button"
                  accessibilityLabel={t('tasks.itemDetailDrawer.refreshDetails', 'Refresh details')}
                  onPress={() => setDetailRefreshSeq((current) => current + 1)}
                >
                  <RefreshCw
                    size={16}
                    color={detailLoading ? colors.textMuted : colors.textSecondary}
                  />
                </Pressable>
              </View>
              <Text style={styles.itemTitle} numberOfLines={3} accessibilityRole="header">
                {actionItem.title}
              </Text>
              <Text style={styles.itemMeta} numberOfLines={1}>
                {[actionItem.subtitle, actionItem.status].filter(Boolean).join(' · ')}
              </Text>
            </View>

            {renderMobileTasksItemActions(model, () => setMenuItemKey(actionItem.key))}

            {renderMobileTasksItemDetailContent(model)}
          </View>
        ) : null}
      </BottomDrawer>
      <ActionSheetModal
        visible={taskUiReady && actionItem != null && menuItemKey === actionItem.key}
        title={actionItem?.title}
        actions={mobileTasksItemMenuActions(model)}
        onClose={() => setMenuItemKey(null)}
      />
    </>
  )
}
