import { Host, Switch } from '@expo/ui/jetpack-compose'
import { semantics, testID as testIDModifier } from '@expo/ui/jetpack-compose/modifiers'
import { materialSeedColor } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { MobileSwitchProps } from './mobile-control-props'

export type { MobileSwitchProps }

/** A Material 3 switch; its label is spoken only, as the row beside it shows the name. */
export function MobileSwitch({
  value,
  onValueChange,
  accessibilityLabel,
  disabled = false,
  testID
}: MobileSwitchProps) {
  const scheme = useMobileColorScheme()
  return (
    <Host matchContents colorScheme={scheme} seedColor={materialSeedColor} style={HOST_STYLE}>
      <Switch
        value={value}
        onCheckedChange={onValueChange}
        enabled={!disabled}
        modifiers={[
          semantics({ contentDescription: accessibilityLabel }),
          ...(testID ? [testIDModifier(testID)] : [])
        ]}
      />
    </Host>
  )
}

const HOST_STYLE = { flexShrink: 0 } as const
