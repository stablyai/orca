import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import { BottomDrawer, View, Text, Pressable, Check, colors } from './mobile-tasks-dependencies'
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
