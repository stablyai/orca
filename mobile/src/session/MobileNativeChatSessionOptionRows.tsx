// The pill and the rows the session-option sheet is built from, kept beside it so the sheet file
// stays about layout and apply wiring.

import type { ReactElement, ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronDown, ShieldAlert, type LucideIcon } from 'lucide-react-native'
import { colors, MIN_TOUCH_TARGET, motion, spacing, textStyles } from '../theme/mobile-theme'
import { ListRow } from '../components/ui/ListRow'
import { MobileSwitch } from '../components/MobileSwitch'
import { pressTransition } from '../components/ui/transition-styles'
import { triggerSelection } from '../platform/haptics'
import {
  sessionOptionValueMarker,
  type SessionOptionDescriptor,
  type SessionOptionValue
} from '../../../src/shared/native-chat-session-options'

/** A footnote under a section header: dispatch state, or why a row is locked. */
export function SessionOptionCaption({ children }: { children: string }): React.JSX.Element {
  return <Text style={styles.caption}>{children}</Text>
}

/** The composer's model pill: the model, then its options muted, a chevron, a shield for full
 *  access. A 36 pt capsule inside the row's 44 pt touch height. */
export function ModelPill({
  primary,
  secondary,
  warning,
  icon: Icon,
  accessibleName,
  disabled,
  onPress
}: {
  primary: string
  secondary: string | null
  warning: boolean
  icon?: LucideIcon
  accessibleName: string
  disabled: boolean
  onPress: () => void
}): React.JSX.Element {
  const PillIcon = Icon ?? (warning ? ShieldAlert : undefined)
  return (
    <Pressable
      accessibilityLabel={accessibleName}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={[styles.pillTouch, disabled && styles.pillDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.pill,
            Icon ? styles.pillIconOnly : null,
            pressed && !disabled && styles.pillPressed,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          {PillIcon ? (
            <PillIcon
              size={15}
              color={warning ? colors.statusAmber : colors.textSecondary}
              strokeWidth={2.2}
            />
          ) : null}
          {!Icon ? (
            <Text style={styles.pillText} numberOfLines={1} ellipsizeMode="tail">
              <Text style={styles.pillPrimary}>{primary}</Text>
              {secondary ? <Text style={styles.pillSecondary}>{` ${secondary}`}</Text> : null}
            </Text>
          ) : null}
          <ChevronDown size={14} color={colors.textMuted} strokeWidth={2.2} />
        </View>
      )}
    </Pressable>
  )
}

/** A trailing value in a colour of its own, as Full access reads in amber. */
function TintedValue({ value, color }: { value: string; color: string }): React.JSX.Element {
  return (
    <Text style={[styles.value, { color }]} numberOfLines={1}>
      {value}
    </Text>
  )
}

export function SessionOptionSummaryRow({
  label,
  value,
  valueColor,
  disabled,
  onPress
}: {
  label: string
  value: string
  valueColor?: string
  disabled: boolean
  /** Absent for a value with no choice to make: the row reads as text, with no page behind it. */
  onPress?: () => void
}): React.JSX.Element {
  const tinted = valueColor ? <TintedValue value={value} color={valueColor} /> : undefined
  return (
    <ListRow
      title={label}
      value={tinted ? undefined : value}
      accessory={tinted}
      navigates={onPress !== undefined}
      onPress={onPress}
      disabled={onPress !== undefined && disabled}
      accessibilityLabel={`${label}, ${value}`}
    />
  )
}

type DescriptorRowsProps = {
  descriptor: SessionOptionDescriptor
  disabled: boolean
  onSetOption: (value: SessionOptionValue) => void
  onInvokeAction: () => void
  /** A choice drawn with a leading mark of its own, as each permission mode has its icon. */
  choiceLeading?: (value: string) => ReactNode
}

/**
 * The rows one descriptor draws, as an array so a `ListGroup` can separate them: a switch where
 * one value flips, one row per choice with a check on the picked one, or a row for an action.
 */
export function descriptorRowElements({
  descriptor,
  disabled,
  onSetOption,
  onInvokeAction,
  choiceLeading
}: DescriptorRowsProps): ReactElement[] {
  const locked = disabled || !descriptor.settable
  // Why: flip-only without a baseline is an action — never claim On/Off.
  if (descriptor.action?.type === 'toggle-command') {
    return [
      <ListRow
        key={descriptor.id}
        title={`Toggle ${descriptor.label.toLowerCase()}`}
        disabled={locked}
        onPress={onInvokeAction}
      />
    ]
  }
  // Why: agent-picker opens the TUI; it is not a set of radio choices.
  if (descriptor.action?.type === 'agent-picker') {
    return [
      <ListRow
        key={descriptor.id}
        title="Choose in agent picker…"
        navigates
        disabled={locked}
        onPress={onInvokeAction}
      />
    ]
  }
  // One switch, not an On/Off pair: the option is binary. The value always renders; the marker is
  // what keeps an unpicked one from reading as confirmed, since the switch cannot say "nobody said".
  if (descriptor.kind.type === 'boolean') {
    const marker = sessionOptionValueMarker(descriptor)
    return [
      <ListRow
        key={descriptor.id}
        title={descriptor.label}
        value={marker ? (marker === 'default' ? 'Default' : 'Not reported') : undefined}
        accessory={
          <MobileSwitch
            accessibilityLabel={descriptor.label}
            value={descriptor.kind.currentValue}
            disabled={locked}
            onValueChange={(next) => {
              triggerSelection()
              onSetOption(next)
            }}
          />
        }
      />
    ]
  }
  const { currentValue, choices } = descriptor.kind
  return choices.map((choice) => {
    const selected = choice.value === currentValue
    const leading = choiceLeading?.(choice.value)
    return (
      <ListRow
        key={choice.value}
        title={choice.label}
        subtitle={choice.description}
        subtitleNumberOfLines={2}
        leading={leading ?? undefined}
        selected={selected}
        accessibilityRole="radio"
        disabled={locked}
        onPress={() => {
          if (!selected) {
            triggerSelection()
          }
          onSetOption(choice.value)
        }}
      />
    )
  })
}

/** The same rows as a component, for a caller that does not need them separated. */
export function DescriptorRows(props: DescriptorRowsProps): React.JSX.Element {
  return <>{descriptorRowElements(props)}</>
}

const PILL_HEIGHT = 36

const styles = StyleSheet.create({
  pillTouch: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    flexShrink: 1,
    minWidth: 0
  },
  pillDisabled: { opacity: motion.disabledOpacity },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: PILL_HEIGHT,
    paddingLeft: 14,
    paddingRight: 10,
    borderRadius: PILL_HEIGHT / 2,
    backgroundColor: colors.fill
  },
  pillIconOnly: { paddingLeft: 11 },
  pillPressed: {
    backgroundColor: colors.fillPressed,
    transform: [{ scale: motion.pressedScale }]
  },
  pillText: {
    ...textStyles.subhead,
    flexShrink: 1
  },
  pillPrimary: {
    color: colors.textPrimary,
    fontWeight: '500'
  },
  pillSecondary: {
    color: colors.textMuted
  },
  caption: {
    ...textStyles.footnote,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg + 4,
    paddingTop: spacing.sm
  },
  value: {
    ...textStyles.callout,
    flexShrink: 1,
    maxWidth: 180
  }
})
