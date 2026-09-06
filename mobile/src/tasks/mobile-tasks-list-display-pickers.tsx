import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  BottomDrawer,
  View,
  Text,
  Pressable,
  Check,
  colors,
  PickerModal
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import {
  LINEAR_VIEW_OPTIONS,
  LINEAR_GROUP_OPTIONS,
  LINEAR_ORDER_OPTIONS,
  LINEAR_DISPLAY_OPTIONS,
  SORT_OPTIONS
} from './mobile-tasks-legacy-foundation'

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
      title="Linear View"
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
      title="Group Linear Issues"
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
      title="Order Linear Issues"
      options={LINEAR_ORDER_OPTIONS}
      selected={linearOrderBy}
      onSelect={setLinearOrderBy}
      onClose={() => setShowLinearOrderPicker(false)}
    />
  )
}

export function renderMobileTasksLinearDisplayPicker(model: ConnectionPresentationModel) {
  const {
    effectiveLinearDisplayProperties,
    setLinearDisplayProperties,
    setLinearTeamPropertyTouched,
    setShowLinearDisplayPicker,
    showLinearDisplayPicker,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && showLinearDisplayPicker}
      onClose={() => setShowLinearDisplayPicker(false)}
    >
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>Display Properties</Text>
      </View>
      <View style={styles.repoPickerGroup}>
        {LINEAR_DISPLAY_OPTIONS.map((property, index) => {
          const selected = effectiveLinearDisplayProperties.has(property.value)
          return (
            <View key={property.value}>
              {index > 0 ? <View style={styles.actionSeparator} /> : null}
              <Pressable
                style={styles.repoPickerRow}
                onPress={() => {
                  if (property.value === 'team') {
                    setLinearTeamPropertyTouched(true)
                  }
                  setLinearDisplayProperties((current) => {
                    const next = new Set(current)
                    if (next.has(property.value)) {
                      next.delete(property.value)
                    } else {
                      next.add(property.value)
                    }
                    return next
                  })
                }}
              >
                <View style={styles.repoPickerTextWrap}>
                  <Text style={styles.repoPickerTitle}>{property.label}</Text>
                </View>
                {selected ? <Check size={15} color={colors.textPrimary} /> : null}
              </Pressable>
            </View>
          )
        })}
      </View>
    </BottomDrawer>
  )
}

export function renderMobileTasksSortPicker(model: ConnectionPresentationModel) {
  const { setShowSortPicker, setTaskSort, showSortPicker, taskSort, taskUiReady } = model
  return (
    <PickerModal
      visible={taskUiReady && showSortPicker}
      title="Sort Tasks"
      options={SORT_OPTIONS}
      selected={taskSort}
      onSelect={setTaskSort}
      onClose={() => setShowSortPicker(false)}
    />
  )
}
