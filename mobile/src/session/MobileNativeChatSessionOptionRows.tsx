// The pill and choice-row primitives the session-option card is built from, kept
// beside it so the card file stays about layout and apply wiring.

import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import { Check, ChevronRight, ShieldAlert } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  sessionOptionValueMarker,
  type SessionOptionDescriptor,
  type SessionOptionValueMarker,
  type SessionOptionValue
} from '../../../src/shared/native-chat-session-options'

/** Muted one-liner above a group — dispatch state, or why a row is locked. */
export function SessionOptionCaption({ children }: { children: string }): React.JSX.Element {
  return <Text style={styles.caption}>{children}</Text>
}

/** The composer's model pill: the model, then its options muted, with a shield for full access. */
export function ModelPill({
  primary,
  secondary,
  warning,
  accessibleName,
  disabled,
  onPress
}: {
  primary: string
  secondary: string | null
  warning: boolean
  accessibleName: string
  disabled: boolean
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityLabel={accessibleName}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.pill, pressed && !disabled && styles.pressed]}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
    >
      {warning ? <ShieldAlert size={15} color={colors.statusAmber} strokeWidth={2.2} /> : null}
      <Text style={styles.pillText} numberOfLines={1} ellipsizeMode="tail">
        <Text style={[styles.pillPrimary, disabled && styles.pillTextDisabled]}>{primary}</Text>
        {secondary ? <Text style={styles.pillSecondary}>{`  ${secondary}`}</Text> : null}
      </Text>
    </Pressable>
  )
}

function ChoiceRow({
  label,
  description,
  selected,
  disabled,
  grouped,
  divided,
  onPress,
  labelColor
}: {
  label: string
  description?: string
  selected: boolean
  disabled: boolean
  grouped: boolean
  divided: boolean
  onPress: () => void
  labelColor?: string
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled }}
      style={[
        styles.row,
        selected && styles.rowSelected,
        grouped && styles.rowGrouped,
        divided && styles.rowDivided,
        disabled && styles.rowDisabled
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <View style={styles.rowBody}>
        <Text style={[styles.rowLabel, labelColor ? { color: labelColor } : null]}>{label}</Text>
        {description ? (
          <Text style={styles.rowDescription} numberOfLines={2}>
            {description}
          </Text>
        ) : null}
      </View>
      {selected ? <Check size={18} color={colors.textPrimary} strokeWidth={2.4} /> : null}
    </Pressable>
  )
}

function ToggleRow({
  label,
  checked,
  marker,
  disabled,
  grouped,
  onToggle
}: {
  label: string
  checked: boolean
  /** Where the rendered value came from, or null once something picked it. */
  marker: SessionOptionValueMarker | null
  disabled: boolean
  grouped: boolean
  onToggle: (next: boolean) => void
}): React.JSX.Element {
  return (
    <View style={[styles.row, grouped && styles.rowGrouped, disabled && styles.rowDisabled]}>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
      </View>
      {marker ? (
        <Text style={styles.rowMarker}>{marker === 'default' ? 'Default' : 'Not reported'}</Text>
      ) : null}
      <Switch
        accessibilityLabel={label}
        value={checked}
        onValueChange={onToggle}
        disabled={disabled}
        trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
        thumbColor={colors.textPrimary}
      />
    </View>
  )
}

function ActionRow({
  label,
  disabled,
  grouped,
  onPress
}: {
  label: string
  disabled: boolean
  grouped: boolean
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={[styles.row, grouped && styles.rowGrouped, disabled && styles.rowDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
      </View>
    </Pressable>
  )
}

export function SessionOptionSummaryRow({
  label,
  value,
  valueColor,
  disabled,
  divided,
  onPress
}: {
  label: string
  value: string
  valueColor?: string
  disabled: boolean
  divided: boolean
  /** Absent for a value with no choice to make: the row reads as text, with no page behind it. */
  onPress?: () => void
}): React.JSX.Element {
  if (!onPress) {
    return (
      <View
        accessible
        accessibilityLabel={`${label}, ${value}`}
        style={[styles.summaryRow, divided && styles.rowDivided]}
      >
        <Text style={styles.summaryLabel}>{label}</Text>
        <Text style={styles.summaryValue} numberOfLines={1}>
          {value}
        </Text>
      </View>
    )
  }
  return (
    <Pressable
      accessibilityLabel={`${label}, ${value}`}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.summaryRow,
        divided && styles.rowDivided,
        pressed && !disabled && styles.pressed,
        disabled && styles.rowDisabled
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text
        style={[styles.summaryValue, valueColor ? { color: valueColor } : null]}
        numberOfLines={1}
      >
        {value}
      </Text>
      <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.2} />
    </Pressable>
  )
}

export function DescriptorRows({
  descriptor,
  disabled,
  grouped = false,
  onSetOption,
  onInvokeAction,
  choiceLabelColor
}: {
  descriptor: SessionOptionDescriptor
  disabled: boolean
  grouped?: boolean
  onSetOption: (value: SessionOptionValue) => void
  onInvokeAction: () => void
  /** A choice whose name reads in a colour of its own, as Full access does. */
  choiceLabelColor?: (value: string) => string | undefined
}): React.JSX.Element {
  const locked = disabled || !descriptor.settable
  // Why: flip-only without a baseline is an action — never claim On/Off.
  if (descriptor.action?.type === 'toggle-command') {
    return (
      <ActionRow
        label={`Toggle ${descriptor.label.toLowerCase()}`}
        disabled={locked}
        grouped={grouped}
        onPress={onInvokeAction}
      />
    )
  }
  // Why: agent-picker opens the TUI; it is not a set of radio choices.
  if (descriptor.action?.type === 'agent-picker') {
    return (
      <ActionRow
        label="Choose in agent picker…"
        disabled={locked}
        grouped={grouped}
        onPress={onInvokeAction}
      />
    )
  }
  // One switch, not an On/Off pair: the option is binary. The value always
  // renders; the marker is what keeps an unpicked one from reading as confirmed,
  // since the switch itself cannot say "nobody said".
  if (descriptor.kind.type === 'boolean') {
    return (
      <ToggleRow
        label={descriptor.label}
        checked={descriptor.kind.currentValue}
        marker={sessionOptionValueMarker(descriptor)}
        disabled={locked}
        grouped={grouped}
        onToggle={(next) => onSetOption(next)}
      />
    )
  }
  const { currentValue, choices } = descriptor.kind
  return (
    <>
      {choices.map((choice, index) => (
        <ChoiceRow
          key={choice.value}
          label={choice.label}
          description={choice.description}
          selected={choice.value === currentValue}
          disabled={locked}
          grouped={grouped}
          divided={grouped && index < choices.length - 1}
          onPress={() => onSetOption(choice.value)}
          labelColor={choiceLabelColor?.(choice.value)}
        />
      ))}
    </>
  )
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 19,
    backgroundColor: colors.composerControl
  },
  pillText: {
    flexShrink: 1,
    fontSize: typography.bodySize
  },
  pillPrimary: {
    color: colors.textPrimary,
    fontWeight: '500'
  },
  pillSecondary: {
    color: colors.textMuted
  },
  pillTextDisabled: {
    color: colors.textMuted
  },
  pressed: {
    opacity: 0.7
  },
  caption: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs
  },
  rowMarker: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: 14,
    paddingVertical: spacing.sm,
    minHeight: 50,
    alignItems: 'center',
    borderRadius: radii.card,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    marginBottom: spacing.xs
  },
  rowSelected: {
    borderColor: colors.textSecondary
  },
  rowGrouped: {
    marginBottom: 0,
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: 'transparent'
  },
  rowDivided: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.composerBorder
  },
  rowDisabled: {
    opacity: 0.5
  },
  rowBody: {
    flex: 1,
    gap: 2
  },
  rowLabel: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  rowDescription: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  summaryRow: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: 14,
    paddingVertical: spacing.sm
  },
  summaryLabel: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  summaryValue: {
    maxWidth: 160,
    color: colors.textSecondary,
    fontSize: typography.bodySize
  }
})
