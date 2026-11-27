import type { ConnectionPresentationModel } from '../../screen-state/use-mobile-tasks-connection-presentation'
import { translate } from '../../../i18n/mobile-i18n'
import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import { View, Text, ActivityIndicator } from 'react-native'
import { colors } from '../../../theme/mobile-theme'
import { ListGroup, ListRow } from '../../../components/list/ListGroup'
import { styles } from '../../mobile-tasks-legacy-styles'
import { TASK_SECONDARY_DRAWER_Z_INDEX } from '../../task-list/mobile-tasks-options'

export function renderMobileTasksLinearStatusPicker(model: ConnectionPresentationModel) {
  const {
    linearStates,
    linearStatesError,
    linearStatesLoading,
    linearStatusPickerItem,
    mutatingStatus,
    setLinearStatus,
    setLinearStatusPickerItem,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && linearStatusPickerItem !== null}
      onClose={() => setLinearStatusPickerItem(null)}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX}
    >
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>
          {translate('tasks.filterPickers.changeStatus', 'Change Status')}
        </Text>
        <Text style={styles.sheetSubtitle}>
          {linearStatusPickerItem?.source.identifier ??
            translate('tasks.filterPickers.linearIssue', 'Linear issue')}
        </Text>
      </View>
      <ListGroup>
        {linearStatesLoading ? (
          <View style={styles.detailLoadingInline}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
            <Text style={styles.detailMuted}>
              {translate('tasks.filterPickers.loadingStates', 'Loading states...')}
            </Text>
          </View>
        ) : linearStatesError ? (
          <Text style={[styles.emptyInlineText, styles.errorText]}>{linearStatesError}</Text>
        ) : linearStates.length === 0 ? (
          <Text style={styles.emptyInlineText}>
            {translate('tasks.filterPickers.noStates', 'No states available')}
          </Text>
        ) : (
          linearStates.map((state) => (
            <ListRow
              key={state.id}
              title={state.name}
              subtitle={state.type}
              leading={
                <View
                  style={[
                    styles.pickerRepoDot,
                    { backgroundColor: state.color || colors.textMuted }
                  ]}
                />
              }
              selected={
                state.name === linearStatusPickerItem?.source.state.name &&
                state.type === linearStatusPickerItem?.source.state.type
              }
              disabled={mutatingStatus}
              onPress={() => {
                if (!linearStatusPickerItem) {
                  return
                }
                void setLinearStatus(linearStatusPickerItem, state, {
                  closeDetail: false
                }).then(() => setLinearStatusPickerItem(null))
              }}
            />
          ))
        )}
      </ListGroup>
    </BottomDrawer>
  )
}
