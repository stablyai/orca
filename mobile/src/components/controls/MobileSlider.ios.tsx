import { useRef } from 'react'
import { Host, Slider } from '@expo/ui/swift-ui'
import {
  accessibilityLabel as accessibilityLabelModifier,
  accessibilityValue,
  disabled as disabledModifier
} from '@expo/ui/swift-ui/modifiers'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { MobileSliderProps } from './mobile-control-props'

export type { MobileSliderProps }

/** A SwiftUI slider; `onSlidingComplete` fires when the drag or accessibility step ends. */
export function MobileSlider({
  value,
  min,
  max,
  step = 1,
  onValueChange,
  onSlidingComplete,
  accessibilityLabel,
  accessibilityValueText,
  disabled = false,
  testID
}: MobileSliderProps) {
  const scheme = useMobileColorScheme()
  const latest = useRef(value)
  latest.current = value
  return (
    <Host matchContents={{ vertical: true }} colorScheme={scheme} style={HOST_STYLE}>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        testID={testID}
        onValueChange={(next) => {
          if (next !== latest.current) {
            latest.current = next
            onValueChange(next)
          }
        }}
        onEditingChanged={(isEditing) => {
          if (!isEditing) {
            onSlidingComplete?.(latest.current)
          }
        }}
        modifiers={[
          accessibilityLabelModifier(accessibilityLabel),
          ...(accessibilityValueText ? [accessibilityValue(accessibilityValueText)] : []),
          disabledModifier(disabled)
        ]}
      />
    </Host>
  )
}

const HOST_STYLE = { alignSelf: 'stretch' } as const
