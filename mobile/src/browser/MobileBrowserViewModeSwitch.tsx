import { Pressable, View } from 'react-native'
import { Monitor, Smartphone, type LucideIcon } from 'lucide-react-native'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { MobileBrowserViewMode } from './browser-screencast-request'

type Props = {
  disabled: boolean
  value: MobileBrowserViewMode
  onChange: (mode: MobileBrowserViewMode) => void
}

function viewModes(t: Translate): { id: MobileBrowserViewMode; label: string; icon: LucideIcon }[] {
  return [
    {
      id: 'web',
      label: t('browser.viewModeSwitch.webView', 'Show web website view'),
      icon: Monitor
    },
    {
      id: 'mobile',
      label: t('browser.viewModeSwitch.mobileView', 'Show mobile website view'),
      icon: Smartphone
    }
  ]
}

export function MobileBrowserViewModeSwitch({
  disabled,
  value,
  onChange
}: Props): React.JSX.Element {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View style={styles.switch}>
      {viewModes(t).map((mode) => (
        <ViewModeButton
          key={mode.id}
          Icon={mode.icon}
          label={mode.label}
          selected={value === mode.id}
          disabled={disabled}
          onPress={() => onChange(mode.id)}
        />
      ))}
    </View>
  )
}

function ViewModeButton({
  Icon,
  disabled,
  label,
  onPress,
  selected
}: {
  Icon: LucideIcon
  disabled?: boolean
  label: string
  onPress: () => void
  selected: boolean
}) {
  useMobileColorScheme()
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        selected && styles.buttonSelected,
        pressed && !disabled && !selected && styles.buttonPressed,
        disabled && styles.disabled
      ]}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={label}
    >
      <Icon size={14} color={selected ? colors.bgBase : colors.textSecondary} />
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  switch: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised,
    padding: 2
  },
  button: {
    minHeight: 24,
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control
  },
  buttonPressed: {
    backgroundColor: colors.borderSubtle
  },
  buttonSelected: {
    backgroundColor: colors.textPrimary
  },
  disabled: {
    opacity: 0.35
  }
}))
