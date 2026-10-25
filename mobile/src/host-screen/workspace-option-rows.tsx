import { Children, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Check, ChevronRight } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { MobileSwitch } from '../components/MobileSwitch'
import type { WorkspaceViewChoice } from '../../../src/shared/workspace-view/workspace-view-options'
import { hostScreenStyles as styles } from './host-screen-styles'
export function CheckRow(props: {
  label: string
  checked: boolean
  onPress: () => void
  detail?: string
  indent?: boolean
  leading?: ReactNode
  radio?: boolean
  disabled?: boolean
}) {
  return (
    <Pressable
      style={[
        styles.filterRow,
        props.indent && styles.optionRowIndented,
        props.disabled && styles.optionRowDisabled
      ]}
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityRole={props.radio ? 'radio' : 'checkbox'}
      accessibilityState={{ checked: props.checked, disabled: props.disabled }}
      accessibilityLabel={props.label}
    >
      {props.leading}
      <View style={styles.optionRowLabel}>
        <Text style={styles.filterRowText} numberOfLines={1}>
          {props.label}
        </Text>
        {props.detail ? (
          <Text style={styles.optionRowDetail} numberOfLines={2}>
            {props.detail}
          </Text>
        ) : null}
      </View>
      {props.checked && <Check size={14} color={colors.textPrimary} />}
    </Pressable>
  )
}

export function OptionRowList({ children }: { children: ReactNode }) {
  return (
    <>
      {Children.map(children, (child, i) => (
        <>
          {i > 0 && <View style={styles.filterSeparator} />}
          {child}
        </>
      ))}
    </>
  )
}

export function ChoiceRows<Id extends string>(props: {
  choices: readonly WorkspaceViewChoice<Id>[]
  selected: Id
  onSelect: (id: Id) => void
}) {
  return (
    <OptionRowList>
      {props.choices.map((choice) => (
        <CheckRow
          key={choice.id}
          label={choice.label}
          detail={choice.description}
          radio
          checked={choice.id === props.selected}
          onPress={() => props.onSelect(choice.id)}
        />
      ))}
    </OptionRowList>
  )
}

/* Only the switch takes the tap, avoiding duplicate writes on web. */
export function SwitchRow(props: {
  label: string
  value: boolean
  onChange: (value: boolean) => void
  indent?: boolean
}) {
  return (
    <View style={[styles.filterRow, props.indent && styles.optionRowIndented]}>
      <Text style={styles.filterRowText} numberOfLines={1}>
        {props.label}
      </Text>
      <MobileSwitch
        value={props.value}
        onValueChange={props.onChange}
        accessibilityLabel={props.label}
      />
    </View>
  )
}

export function DrillRow(props: { label: string; value: string; onPress: () => void }) {
  return (
    <Pressable
      style={styles.filterRow}
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={props.value ? `${props.label}, ${props.value}` : props.label}
    >
      <Text style={styles.filterRowText} numberOfLines={1}>
        {props.label}
      </Text>
      <Text style={styles.optionRowValue} numberOfLines={1}>
        {props.value}
      </Text>
      <ChevronRight size={16} color={colors.textMuted} />
    </Pressable>
  )
}
