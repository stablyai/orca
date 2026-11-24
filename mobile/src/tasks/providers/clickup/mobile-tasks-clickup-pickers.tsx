import { ActivityIndicator, Text, View } from 'react-native'
import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import { ListGroup, ListRow } from '../../../components/list/ListGroup'
import { PickerModal } from '../../../components/sheets/PickerModal'
import { translate } from '../../../i18n/mobile-i18n'
import { colors } from '../../../theme/mobile-theme'
import { styles } from '../../mobile-tasks-legacy-styles'
import type { ConnectionPresentationModel } from '../../screen-state/use-mobile-tasks-connection-presentation'
import { TASK_SECONDARY_DRAWER_Z_INDEX } from '../../task-list/mobile-tasks-options'
import { clickUpWorkspaceLabel, extractClickUpConnection } from './clickup-mobile-connection'
import { safeClickUpColor } from '../../../../../src/shared/clickup/clickup-color'
import { CLICKUP_SCOPE_OPTIONS } from './mobile-clickup-filters'
import { clickUpWorkspaceSelect } from './mobile-clickup-operations'

export function renderMobileTasksClickUpScopePicker(model: ConnectionPresentationModel) {
  const { clickupFilter, setClickUpFilter, setShowClickUpScopePicker, showClickUpScopePicker } =
    model
  return (
    <PickerModal
      visible={model.taskUiReady && showClickUpScopePicker}
      title={translate('tasks.clickUp.scopeTitle', 'ClickUp Tasks')}
      options={CLICKUP_SCOPE_OPTIONS}
      selected={clickupFilter.scope}
      onSelect={(scope) => setClickUpFilter((current) => ({ ...current, scope }))}
      onClose={() => setShowClickUpScopePicker(false)}
    />
  )
}

// ClickUp keeps the Workspace choice on the desktop, so picking one here switches it there too.
export function renderMobileTasksClickUpWorkspacePicker(model: ConnectionPresentationModel) {
  const {
    client,
    clickupConnection,
    clickupStatusRequestIdRef,
    setClickUpConnection,
    setError,
    setItems,
    setShowClickUpWorkspacePicker,
    showClickUpWorkspacePicker
  } = model
  return (
    <PickerModal
      visible={model.taskUiReady && showClickUpWorkspacePicker}
      title={translate('tasks.clickUp.workspaceTitle', 'ClickUp Workspace')}
      subtitle={translate(
        'tasks.clickUp.workspaceHostNote',
        'Also switches the Workspace in Orca on your desktop.'
      )}
      options={clickupConnection.workspaces.map((workspace) => ({
        value: workspace.id,
        label: clickUpWorkspaceLabel(workspace)
      }))}
      selected={clickupConnection.selectedWorkspaceId ?? ''}
      onSelect={(workspaceId) => {
        if (!client || workspaceId === clickupConnection.selectedWorkspaceId) {
          return
        }
        // Shares the status counter so a reply from an earlier pick or an older status read cannot overwrite the latest.
        const requestId = ++clickupStatusRequestIdRef.current
        void clickUpWorkspaceSelect
          .request(client, { workspaceId })
          .then((reply) => {
            const next = extractClickUpConnection(clickUpWorkspaceSelect.interpret(reply))
            if (clickupStatusRequestIdRef.current !== requestId) {
              return
            }
            setItems([])
            setClickUpConnection(next)
          })
          .catch((err: unknown) => {
            if (clickupStatusRequestIdRef.current !== requestId) {
              return
            }
            setError(
              err instanceof Error
                ? err.message
                : translate('tasks.clickUp.switchWorkspaceFailed', 'Failed to switch Workspace')
            )
          })
      }}
      onClose={() => setShowClickUpWorkspacePicker(false)}
    />
  )
}

export function renderMobileTasksClickUpStatusPicker(model: ConnectionPresentationModel) {
  const {
    clickupStatusOptions,
    clickupStatusPickerItem,
    clickupStatusesError,
    clickupStatusesLoading,
    mutatingStatus,
    setClickUpStatus,
    setClickUpStatusPickerItem,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && clickupStatusPickerItem !== null}
      onClose={() => setClickUpStatusPickerItem(null)}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX}
    >
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>
          {translate('tasks.clickUp.changeStatus', 'Change Status')}
        </Text>
        <Text style={styles.sheetSubtitle}>
          {clickupStatusPickerItem?.source.list.name ??
            translate('tasks.clickUp.task', 'ClickUp task')}
        </Text>
      </View>
      <ListGroup>
        {clickupStatusesLoading ? (
          <View style={styles.detailLoadingInline}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
            <Text style={styles.detailMuted}>
              {translate('tasks.clickUp.loadingStatuses', 'Loading statuses...')}
            </Text>
          </View>
        ) : clickupStatusesError ? (
          <Text style={[styles.emptyInlineText, styles.errorText]}>{clickupStatusesError}</Text>
        ) : clickupStatusOptions.length === 0 ? (
          <Text style={styles.emptyInlineText}>
            {translate('tasks.clickUp.noStatuses', 'This list has no statuses to choose from')}
          </Text>
        ) : (
          clickupStatusOptions.map((status) => (
            <ListRow
              key={status.name}
              title={status.name}
              leading={
                <View
                  style={[
                    styles.pickerRepoDot,
                    { backgroundColor: safeClickUpColor(status.color) ?? colors.textMuted }
                  ]}
                />
              }
              selected={status.name === clickupStatusPickerItem?.source.status.name}
              disabled={mutatingStatus}
              onPress={() => {
                if (!clickupStatusPickerItem) {
                  return
                }
                void setClickUpStatus(clickupStatusPickerItem, status).then((updated) => {
                  if (updated) {
                    setClickUpStatusPickerItem(null)
                  }
                })
              }}
            />
          ))
        )}
      </ListGroup>
    </BottomDrawer>
  )
}
