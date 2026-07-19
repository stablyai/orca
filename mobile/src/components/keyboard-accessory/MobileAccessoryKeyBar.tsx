import type React from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import type { AccessoryKeyDescriptor } from './accessory-key-descriptor'
import { accessoryKeyStyles as styles } from './mobile-accessory-key-styles'

type Props = {
  keys: AccessoryKeyDescriptor[]
  // Bar-wide disabled state; a descriptor's own `disabled` overrides it (nullish).
  disabled?: boolean
  // Fixed slot rendered before the scrollable keys and never scrolled away
  // (the terminal keyboard-dismiss key lives here, per issue #5106).
  leading?: React.ReactNode
}

export function MobileAccessoryKeyBar({
  keys,
  disabled = false,
  leading
}: Props): React.JSX.Element {
  return (
    <View style={styles.accessoryBar}>
      {leading}
      {/* Why: keyboardShouldPersistTaps keeps the open keyboard alive on the first
      accessory tap instead of swallowing it to dismiss the keyboard (#5106). */}
      <ScrollView
        style={styles.accessoryScroll}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.accessoryContent}
        keyboardShouldPersistTaps="always"
      >
        {keys.map((key) => {
          const isDisabled = key.disabled ?? disabled
          return (
            <Pressable
              key={key.id}
              style={({ pressed }) => [
                styles.accessoryKey,
                key.bordered && styles.customAccessoryKey,
                key.active && styles.accessoryKeyActive,
                pressed && styles.accessoryKeyPressed,
                isDisabled && styles.accessoryKeyDisabled
              ]}
              disabled={isDisabled}
              accessibilityRole="button"
              // Why: announce sticky modifier state so assistive tech reads active keys as selected.
              accessibilityState={{ disabled: isDisabled, selected: key.active }}
              onPress={key.onPress}
              onPressIn={key.onPressIn}
              onPressOut={key.onPressOut}
              onLongPress={key.onLongPress}
              delayLongPress={key.delayLongPress}
              accessibilityLabel={key.accessibilityLabel}
            >
              {key.icon ?? (
                <Text
                  style={[
                    styles.accessoryKeyText,
                    key.active && styles.accessoryKeyTextActive,
                    isDisabled && styles.accessoryKeyTextDisabled
                  ]}
                >
                  {key.label}
                </Text>
              )}
            </Pressable>
          )
        })}
      </ScrollView>
    </View>
  )
}
