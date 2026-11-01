import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import { PickerModal, type PickerOption } from '../components/PickerModal'
import { colors } from '../theme/mobile-theme'
import { automationStyles as styles } from './automation-styles'

export function AutomationButton(props: {
  label: string
  onPress: () => void
  disabled?: boolean
  primary?: boolean
  destructive?: boolean
}) {
  useMobileColorScheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[
        styles.button,
        props.primary && styles.primaryButton,
        props.disabled && styles.disabled
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          props.primary && styles.primaryText,
          props.destructive && styles.destructiveText
        ]}
      >
        {props.label}
      </Text>
    </Pressable>
  )
}
export function AutomationField(props: {
  label: string
  value: string
  onChange: (value: string) => void
  multiline?: boolean
  numeric?: boolean
  literal?: boolean
  disabled?: boolean
}) {
  useMobileColorScheme()
  const literal = props.literal || props.numeric
  return (
    <View style={styles.field}>
      <Text style={styles.meta}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        style={[styles.input, props.multiline && styles.multiline]}
        placeholderTextColor={colors.textMuted}
        value={props.value}
        onChangeText={props.onChange}
        multiline={props.multiline}
        editable={!props.disabled}
        keyboardType={props.numeric ? 'numeric' : 'default'}
        autoCapitalize="none"
        autoCorrect={literal ? false : undefined}
        spellCheck={literal ? false : undefined}
        smartInsertDelete={literal ? false : undefined}
        autoComplete={literal ? 'off' : undefined}
      />
    </View>
  )
}
export function AutomationChoice<Value extends string>(props: {
  label: string
  value: Value
  options: PickerOption<Value>[]
  onSelect: (value: Value) => void
  disabled?: boolean
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [open, setOpen] = useState(false)
  return (
    <View style={styles.field}>
      <Text style={styles.meta}>{props.label}</Text>
      <AutomationButton
        label={
          props.options.find((option) => option.value === props.value)?.label ??
          t('automations.mobile.choose', 'Choose…')
        }
        onPress={() => setOpen(true)}
        disabled={props.disabled}
      />
      <PickerModal
        visible={open}
        title={props.label}
        options={props.options}
        selected={props.value}
        onSelect={props.onSelect}
        onClose={() => setOpen(false)}
        searchable={props.options.length > 6}
      />
    </View>
  )
}
export function AutomationMetadata({ label, value }: { label: string; value: string }) {
  useMobileColorScheme()
  return (
    <View style={styles.stack}>
      <Text style={styles.meta}>{label}</Text>
      <Text selectable style={styles.text}>
        {value}
      </Text>
    </View>
  )
}
