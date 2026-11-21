import { SegmentedControl } from '@expo/ui/community/segmented-control'
import { StyleSheet, type ViewStyle } from 'react-native'
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
      style={layout}
      testID={props.testIDPrefix}
    />
  )
}
