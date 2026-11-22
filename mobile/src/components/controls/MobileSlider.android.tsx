import { useRef } from 'react'
import { Host, Slider } from '@expo/ui/jetpack-compose'
import { semantics, testID as testIDModifier } from '@expo/ui/jetpack-compose/modifiers'
import { materialSeedColor } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { MobileSliderProps } from './mobile-control-props'

export type { MobileSliderProps }

/** A Material 3 slider; `onSlidingComplete` fires when the drag or accessibility step ends. */
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
  // Compose counts the stops between the ends, not the step size.
  const steps = Math.max(0, Math.round((max - min) / step) - 1)
  return (
    <Host
      matchContents={{ vertical: true }}
      colorScheme={scheme}
      seedColor={materialSeedColor}
      style={HOST_STYLE}
    >
      <Slider
        value={value}
        min={min}
        max={max}
        steps={steps}
        enabled={!disabled}
        onValueChange={(raw) => {
          const next = Math.min(
            max,
            Math.max(min, Number((min + Math.round((raw - min) / step) * step).toFixed(6)))
          )
          if (next !== latest.current) {
            latest.current = next
            onValueChange(next)
          }
        }}
        onValueChangeFinished={() => onSlidingComplete?.(latest.current)}
        modifiers={[
          // This semantics API has no value description, so the spoken value rides on the label.
          semantics({
            contentDescription: [accessibilityLabel, accessibilityValueText]
              .filter(Boolean)
              .join(', ')
          }),
          ...(testID ? [testIDModifier(testID)] : [])
        ]}
      />
    </Host>
  )
}

const HOST_STYLE = { alignSelf: 'stretch' } as const
