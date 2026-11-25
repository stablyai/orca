import { SegmentedControl } from '@expo/ui/community/segmented-control'
import { Platform, StyleSheet, type ViewStyle } from 'react-native'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { MobileSegmentedControlProps } from './DrawnSegmentedControl'

// The track's paint belongs to the drawn control; the native one keeps only where it sits.
const LAYOUT_KEYS = [
  'alignSelf',
  'flex',
  'flexGrow',
  'flexShrink',
  'width',
  'minWidth',
  'maxWidth',
  'margin',
  'marginHorizontal',
  'marginVertical',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'marginStart',
  'marginEnd'
] as const satisfies readonly (keyof ViewStyle)[]

/** SwiftUI's segmented picker on iOS, Material 3 segmented buttons on Android. */
export function NativeSegmentedControl<Value extends string>(
  props: MobileSegmentedControlProps<Value>
) {
  const scheme = useMobileColorScheme()
  const flat = StyleSheet.flatten(props.style) ?? {}
  const layout: ViewStyle = {}
  for (const key of LAYOUT_KEYS) {
    if (flat[key] !== undefined) {
      Object.assign(layout, { [key]: flat[key] })
    }
  }
  const index = props.segments.findIndex((segment) => segment.value === props.selected)
  return (
    <SegmentedControl
      values={props.segments.map((segment) => segment.label)}
      selectedIndex={index !== -1 ? index : undefined}
      onChange={(event) => {
        const segment = props.segments[event.nativeEvent.selectedSegmentIndex]
        if (segment) {
          props.onSelect(segment.value)
        }
      }}
      enabled={props.disabled !== true}
      appearance={scheme}
      // Compose's baseline picks a lavender segment; iOS keeps the system look.
      tintColor={Platform.OS === 'android' ? colors.translucentFill : undefined}
      style={layout}
      testID={props.testIDPrefix}
    />
  )
}
