import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useState, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
import { ListRow } from '../components/list/ListGroup'
import { Plus } from '../components/icons/app-icons'
import { describeLoadError } from '../components/feedback/load-error-description'
import { MobileLoadErrorState } from '../components/feedback/MobileStateView'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { SettingsNote } from '../settings/settings-screen-frame'
import { PickerModal, type PickerOption } from '../components/sheets/PickerModal'
import { pressedStyle } from '../theme/mobile-theme'
import { automationStyles as styles } from './automation-styles'
import { FieldTextInput } from '../components/composer-input/FieldTextInput'

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
      style={({ pressed }) => [
        styles.button,
        props.primary && styles.primaryButton,
        props.disabled && styles.disabled,
        pressed && pressedStyle
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
      <FieldTextInput
        accessibilityLabel={props.label}
        style={[styles.input, props.multiline && styles.multiline]}
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
export type AutomationHeaderBar = {
  /** On an automation's page: its name, next run and the way back to the list, in place of the tabs. */
  page?: { title: string; subtitle: string; onBack: () => void }
  trailing?: ReactNode
}

/** The list's bar button that starts a new automation. */
export function AutomationNewButton(props: { disabled: boolean; onPress: () => void }) {
  const t = useMobileTranslation()
  return (
    <NavBarButton
      icon={Plus}
      accessibilityLabel={t('automations.mobile.newAutomation', 'New automation')}
      onPress={props.onPress}
      disabled={props.disabled}
    />
  )
}

/** Above the content: offline, a failed action, or a list that never loaded. */
export function AutomationCatalogNotes(props: {
  connected: boolean
  error: string | null
  failedLoad: boolean
  onRetry: (() => void) | null
}) {
  const t = useMobileTranslation()
  return (
    <>
      {!props.connected ? (
        <SettingsNote>
          {t(
            'automations.mobile.reconnectToThisHostToRefreshOrMakeChangesSavedInformationRemainsAvailableBelow',
            'Reconnect to this host to refresh or make changes. Saved information remains available below.'
          )}
        </SettingsNote>
      ) : null}
      {props.failedLoad ? (
        <MobileLoadErrorState error={props.error} onRetry={props.onRetry} />
      ) : props.error ? (
        <SettingsNote error>{describeLoadError(props.error, t).message}</SettingsNote>
      ) : null}
    </>
  )
}

/** AutomationChoice as a grouped-list row: the label, the picked value, and a picker. */
export function AutomationChoiceRow<Value extends string>(props: {
  label: string
  value: Value
  options: PickerOption<Value>[]
  onSelect: (value: Value) => void
}) {
  useMobileColorScheme()
  const [open, setOpen] = useState(false)
  return (
    <>
      <ListRow
        title={props.label}
        value={props.options.find((option) => option.value === props.value)?.label}
        navigates
        onPress={() => setOpen(true)}
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
    </>
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
// The bar's Automations / Runs switch, inset like Source Control's.
export function AutomationTabs(props: {
  selected: 'automations' | 'runs'
  onSelect: (tab: 'automations' | 'runs') => void
  disabled: boolean
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <MobileSegmentedControl
      fill
      tabs
      style={styles.tabs}
      segments={[
        { value: 'automations', label: t('automations.mobile.automations', 'Automations') },
        { value: 'runs', label: t('automations.mobile.runs', 'Runs') }
      ]}
      selected={props.selected}
      onSelect={props.onSelect}
      disabled={props.disabled}
    />
  )
}
