import { Host, Toggle } from '@expo/ui/swift-ui'
import {
  accessibilityLabel as accessibilityLabelModifier,
  disabled as disabledModifier,
  labelsHidden
} from '@expo/ui/swift-ui/modifiers'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { MobileSwitchProps } from './mobile-control-props'

export type { MobileSwitchProps }

/** A SwiftUI toggle; its label is spoken only, as the row beside it shows the name. */
export function MobileSwitch({
  value,
  onValueChange,
  accessibilityLabel,
  disabled = false,
  testID
}: MobileSwitchProps) {
  const scheme = useMobileColorScheme()
  return (
    <Host matchContents colorScheme={scheme} style={HOST_STYLE}>
      <Toggle
        isOn={value}
        onIsOnChange={onValueChange}
        label={accessibilityLabel}
        testID={testID}
        modifiers={[
          labelsHidden(),
          accessibilityLabelModifier(accessibilityLabel),
          disabledModifier(disabled)
        ]}
      />
    </Host>
  )
}

const HOST_STYLE = { flexShrink: 0 } as const
