import type React from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import type { AccessoryKeyDescriptor } from './accessory-key-descriptor'
import { accessoryKeyStyles as styles } from './mobile-accessory-key-styles'

type Props = {
  keys: AccessoryKeyDescriptor[]
  // Bar-wide disabled state; a descriptor's own `disabled` overrides it (nullish).
  disabled?: boolean
  // Keeps keyboard dismissal visible when the keys scroll.
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
      {/* Keep the first accessory tap from dismissing the keyboard (#5106). */}
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
                pressed && !key.active && styles.accessoryKeyPressed,
                isDisabled && styles.accessoryKeyDisabled
              ]}
              disabled={isDisabled}
              accessibilityRole="button"
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
