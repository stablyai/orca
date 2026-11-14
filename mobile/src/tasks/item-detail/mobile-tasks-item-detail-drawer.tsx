import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { ActionSheetModal } from '../../components/ActionSheetModal'
import { View, Text, Pressable } from 'react-native'
import { TaskProviderLogo } from '../../components/TaskProviderLogo'
import { colors, pressedStyle } from '../../theme/mobile-theme'
import { RefreshCw } from 'lucide-react-native'
import { useState } from 'react'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { styles } from '../mobile-tasks-legacy-styles'
import { taskKindLabel } from './mobile-tasks-item-comments'
import { renderMobileTasksItemDetailContent } from './mobile-tasks-item-detail-content'
import {
  mobileTasksItemMenuActions,
  renderMobileTasksItemActions
} from './mobile-tasks-item-actions'

export function MobileTasksItemDetailDrawer({ model }: { model: ConnectionPresentationModel }) {
  const { actionItem, detailLoading, taskDetailHandoff, requestDetailRefresh, taskUiReady } = model
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
                  style={({ pressed }) => [styles.iconButton, pressed && pressedStyle]}
                  disabled={detailLoading}
                  accessibilityRole="button"
                  accessibilityLabel={t('tasks.itemDetailDrawer.refreshDetails', 'Refresh details')}
                  onPress={requestDetailRefresh}
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
