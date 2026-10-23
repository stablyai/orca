import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { BottomDrawer, PickerModal, triggerSelection } from './mobile-tasks-dependencies'
import {
  LINEAR_VIEW_OPTIONS,
  LINEAR_GROUP_OPTIONS,
  LINEAR_ORDER_OPTIONS,
  LINEAR_DISPLAY_OPTIONS,
  SORT_OPTIONS,
  type LinearDisplayProperty
} from './mobile-tasks-legacy-foundation'
import { ListGroup } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { MobileTasksSheetHeader, sheetStyles } from './mobile-tasks-sheet-chrome'

export function renderMobileTasksLinearViewPicker(model: ConnectionPresentationModel) {
  const {
    linearViewMode,
    setLinearViewMode,
    setShowLinearViewPicker,
    showLinearViewPicker,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showLinearViewPicker}
      title="Layout"
      options={LINEAR_VIEW_OPTIONS}
      selected={linearViewMode}
      onSelect={setLinearViewMode}
      onClose={() => setShowLinearViewPicker(false)}
    />
  )
}

export function renderMobileTasksLinearGroupPicker(model: ConnectionPresentationModel) {
  const {
    linearGroupBy,
    setLinearGroupBy,
    setShowLinearGroupPicker,
    showLinearGroupPicker,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showLinearGroupPicker}
      title="Group by"
      options={LINEAR_GROUP_OPTIONS}
      selected={linearGroupBy}
      onSelect={setLinearGroupBy}
      onClose={() => setShowLinearGroupPicker(false)}
    />
  )
}

export function renderMobileTasksLinearOrderPicker(model: ConnectionPresentationModel) {
  const {
    linearOrderBy,
    setLinearOrderBy,
    setShowLinearOrderPicker,
    showLinearOrderPicker,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showLinearOrderPicker}
      title="Order by"
      options={LINEAR_ORDER_OPTIONS}
      selected={linearOrderBy}
      onSelect={setLinearOrderBy}
      onClose={() => setShowLinearOrderPicker(false)}
    />
  )
}

export function toggleMobileTasksLinearDisplayProperty(
  model: ConnectionPresentationModel,
  property: LinearDisplayProperty
) {
  const { setLinearDisplayProperties, setLinearTeamPropertyTouched } = model
  if (property === 'team') {
    setLinearTeamPropertyTouched(true)
  }
  setLinearDisplayProperties((current) => {
    const next = new Set(current)
    if (next.has(property)) {
      next.delete(property)
    } else {
      next.add(property)
    }
    return next
  })
}

export function renderMobileTasksLinearDisplayRows(model: ConnectionPresentationModel) {
  const { effectiveLinearDisplayProperties } = model
  return LINEAR_DISPLAY_OPTIONS.map((property) => (
    <ListRow
      key={property.value}
      title={property.label}
      selected={effectiveLinearDisplayProperties.has(property.value)}
      accessibilityRole="button"
      onPress={() => {
        triggerSelection()
        toggleMobileTasksLinearDisplayProperty(model, property.value)
      }}
    />
  ))
}

export function renderMobileTasksLinearDisplayPicker(model: ConnectionPresentationModel) {
  const { setShowLinearDisplayPicker, showLinearDisplayPicker, taskUiReady } = model
  return (
    <BottomDrawer
      visible={taskUiReady && showLinearDisplayPicker}
      onClose={() => setShowLinearDisplayPicker(false)}
    >
      <MobileTasksSheetHeader
        title="Show on rows"
        trailing={{
          label: 'Done',
          onPress: () => setShowLinearDisplayPicker(false)
        }}
      />
      <ListGroup style={sheetStyles.group}>{renderMobileTasksLinearDisplayRows(model)}</ListGroup>
    </BottomDrawer>
  )
}

export function renderMobileTasksSortPicker(model: ConnectionPresentationModel) {
  const { setShowSortPicker, setTaskSort, showSortPicker, taskSort, taskUiReady } = model
  return (
    <PickerModal
      visible={taskUiReady && showSortPicker}
      title="Sort by"
      options={SORT_OPTIONS}
      selected={taskSort}
      onSelect={setTaskSort}
      onClose={() => setShowSortPicker(false)}
    />
  )
}
