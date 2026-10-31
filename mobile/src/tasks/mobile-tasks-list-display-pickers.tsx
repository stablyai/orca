import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import { BottomDrawer, View, Text } from './mobile-tasks-dependencies'
import { ListGroup } from '../components/list/ListGroup'
import { ListRow } from '../components/list/ListRow'
import { styles } from './mobile-tasks-legacy-styles'
import { LINEAR_DISPLAY_OPTIONS } from './mobile-tasks-legacy-foundation'

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
        <Text style={styles.sheetTitle}>
          {translate('tasks.listDisplayPickers.displayPropertiesTitle', 'Display Properties')}
        </Text>
      </View>
      <ListGroup>
        {LINEAR_DISPLAY_OPTIONS.map((property) => (
          <ListRow
            key={property.value}
            title={property.label}
            selected={effectiveLinearDisplayProperties.has(property.value)}
            accessibilityRole="checkbox"
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
          />
        ))}
      </ListGroup>
    </BottomDrawer>
  )
}
