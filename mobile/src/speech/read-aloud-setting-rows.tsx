import { Fragment } from 'react'
import { View, Text, Pressable } from 'react-native'
import { Check } from 'lucide-react-native'
import { MobileSwitch } from '../components/MobileSwitch'
import { voiceSettingsStyles as styles } from '../settings/voice-settings-styles'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export type Option<T extends string> = { value: T; label: string; sublabel: string }

/** A Read aloud setting picked from a list, one choice at a time. */
export function OptionRows<T extends string>({
  options,
  selected,
  onSelect,
  disabled = false
}: {
  options: readonly Option<T>[]
  selected: T
  onSelect: (value: T) => void
  disabled?: boolean
}) {
  useMobileColorScheme()
  return (
    <View style={[styles.section, styles.sectionTopGap]} accessibilityRole="radiogroup">
      {options.map((option, index) => (
        <Fragment key={option.value}>
          {index > 0 ? <View style={styles.separator} /> : null}
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: option.value === selected, disabled }}
            disabled={disabled}
            style={styles.row}
            onPress={() => onSelect(option.value)}
          >
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>{option.label}</Text>
              <Text style={styles.rowSublabel}>{option.sublabel}</Text>
            </View>
            {option.value === selected ? <Check size={18} color={colors.textPrimary} /> : null}
          </Pressable>
        </Fragment>
      ))}
    </View>
  )
}

/** An on/off Read aloud setting; `sublabel` says what the current value does. */
export function SwitchRow({
  label,
  sublabel,
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel = label
}: {
  label: string
  sublabel: string
  value: boolean
  onValueChange: (value: boolean) => void
  disabled?: boolean
  accessibilityLabel?: string
}) {
  useMobileColorScheme()
  return (
    <View style={styles.row}>
      <View style={styles.rowContent}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowSublabel}>{sublabel}</Text>
      </View>
      <MobileSwitch
        accessibilityLabel={accessibilityLabel}
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
      />
    </View>
  )
}
