import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { Check } from 'lucide-react-native'
import { colors, motion, spacing, textStyles } from '../theme/mobile-theme'
import { MobileSwitch } from '../components/MobileSwitch'
import { ListGroup, LIST_ROW_PADDING } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { pressTransition } from '../components/ui/transition-styles'
import { triggerSelection } from '../platform/haptics'
import type { WorkspaceViewChoice } from '../../../src/shared/workspace-view/workspace-view-options'

// A sub-option sits under its parent, past where the parent's label starts.
const INDENT = 28

/** A pick: a check on the right, as an iOS settings list. Keeps checkbox semantics for multi-picks. */
export function CheckRow(props: {
  label: string
  checked: boolean
  onPress: () => void
  detail?: string
  indent?: boolean
  leading?: ReactNode
  /** Pick-one rows read as radio buttons. */
  radio?: boolean
  disabled?: boolean
}) {
  return (
    <Pressable
      onPress={() => {
        triggerSelection()
        props.onPress()
      }}
      disabled={props.disabled}
      accessibilityRole={props.radio ? 'radio' : 'checkbox'}
      accessibilityState={{ checked: props.checked, disabled: props.disabled }}
      accessibilityLabel={props.label}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.row,
            props.detail ? styles.rowTwoLine : null,
            props.indent && styles.indented,
            pressed && styles.pressed,
            props.disabled && styles.disabled,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          {props.leading}
          <View style={styles.main}>
            <Text style={styles.label} numberOfLines={1}>
              {props.label}
            </Text>
            {props.detail ? (
              <Text style={styles.detail} numberOfLines={2}>
                {props.detail}
              </Text>
            ) : null}
          </View>
          {props.checked ? (
            <Check size={18} color={colors.textPrimary} strokeWidth={2.4} />
          ) : (
            <View style={styles.checkSpace} />
          )}
        </View>
      )}
    </Pressable>
  )
}

/** One option's inset group, hairlines between rows; sized for the sheet's padding. */
export function OptionGroup({
  children,
  style
}: {
  children: ReactNode
  style?: StyleProp<ViewStyle>
}) {
  return <ListGroup style={[styles.group, style]}>{children}</ListGroup>
}

/** Rows with a hairline between each, inside a group the caller frames. */
export function OptionRowList({ children }: { children: ReactNode }) {
  return <ListGroup appearance="plain">{children}</ListGroup>
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

/** A filter switch, as the desktop's switch rows; only the switch takes the tap (one write on web). */
export function SwitchRow(props: {
  label: string
  value: boolean
  onChange: (value: boolean) => void
  indent?: boolean
}) {
  return (
    <View style={[styles.row, props.indent && styles.indented]}>
      <Text style={[styles.label, styles.main]} numberOfLines={2}>
        {props.label}
      </Text>
      <MobileSwitch
        value={props.value}
        onValueChange={(next) => {
          triggerSelection()
          props.onChange(next)
        }}
        accessibilityLabel={props.label}
      />
    </View>
  )
}

/** An option with its current value; tapping it opens the option's own page. */
export function DrillRow(props: { label: string; value: string; onPress: () => void }) {
  return (
    <ListRow
      title={props.label}
      value={props.value || undefined}
      navigates
      onPress={props.onPress}
      accessibilityLabel={props.value ? `${props.label}, ${props.value}` : props.label}
    />
  )
}

const styles = StyleSheet.create({
  group: { marginHorizontal: spacing.xs },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: 10
  },
  rowTwoLine: { minHeight: 64 },
  indented: { paddingLeft: LIST_ROW_PADDING + INDENT },
  pressed: { backgroundColor: colors.fill },
  disabled: { opacity: motion.disabledOpacity },
  main: { flex: 1, minWidth: 0, gap: 2 },
  label: { ...textStyles.body, color: colors.textPrimary },
  detail: { ...textStyles.subhead, color: colors.textSecondary },
  checkSpace: { width: 18 }
})
