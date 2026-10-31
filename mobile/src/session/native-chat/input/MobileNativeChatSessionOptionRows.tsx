import type { ReactElement, ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ShieldAlert, type LucideIcon } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { Translate } from '../../../i18n/mobile-i18n'
import { ListRow } from '../../../components/list/ListRow'
import { LIST_ROW_PADDING } from '../../../components/list/ListGroup'
import {
  sessionOptionValueMarker,
  type SessionOptionDescriptor,
  type SessionOptionValue
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  nativeChatSessionChoiceLabel,
  nativeChatSessionOptionActionLabel,
  nativeChatSessionOptionLabel
} from '../../../../../src/shared/native-chat-session-option-labels'
import { sayMobileNativeChatSessionOption as say } from './native-chat-session-option-copy'
import { MobileSwitch } from '../../../components/MobileSwitch'

export function SessionOptionCaption({ children }: { children: string }): React.JSX.Element {
  useMobileColorScheme()
  return <Text style={styles.caption}>{children}</Text>
}

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
  useMobileColorScheme()
  const PillIcon = Icon ?? (warning ? ShieldAlert : undefined)
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
      {PillIcon ? (
        <PillIcon
          size={15}
          color={warning ? colors.statusAmber : disabled ? colors.textMuted : colors.textSecondary}
          strokeWidth={2.2}
        />
      ) : null}
      {!Icon ? (
        <Text style={styles.pillText} numberOfLines={1} ellipsizeMode="tail">
          <Text style={[styles.pillPrimary, disabled && styles.pillTextDisabled]}>{primary}</Text>
          {secondary ? <Text style={styles.pillSecondary}>{`  ${secondary}`}</Text> : null}
        </Text>
      ) : null}
    </Pressable>
  )
}

/** A trailing value in a colour of its own, as Full access reads in amber. */
function TintedValue({ value, color }: { value: string; color: string }): React.JSX.Element {
  useMobileColorScheme()
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
  onPress?: () => void
}): React.JSX.Element {
  const tinted = valueColor ? <TintedValue value={value} color={valueColor} /> : undefined
  const row = (
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
  if (onPress) {
    return row
  }
  return (
    <View accessible accessibilityLabel={`${label}, ${value}`}>
      {row}
    </View>
  )
}

type DescriptorRowsProps = {
  descriptor: SessionOptionDescriptor
  disabled: boolean
  onSetOption: (value: SessionOptionValue) => void
  onInvokeAction: () => void
  /** A leading mark per choice, as each permission mode has its icon. */
  choiceLeading?: (value: string) => ReactNode
}

/** One descriptor's rows as an array, so a ListGroup can draw the separators between them. */
export function descriptorRowElements(
  { descriptor, disabled, onSetOption, onInvokeAction, choiceLeading }: DescriptorRowsProps,
  t: Translate
): ReactElement[] {
  const locked = disabled || !descriptor.settable
  // Why: flip-only and agent-picker options are actions, not values or radio choices.
  if (descriptor.action) {
    return [
      <ListRow
        key={descriptor.id}
        title={nativeChatSessionOptionActionLabel(descriptor, say)}
        disabled={locked}
        onPress={onInvokeAction}
      />
    ]
  }
  // An unknown baseline still renders a switch; the source marker prevents implying the value was confirmed.
  if (descriptor.kind.type === 'boolean') {
    const label = nativeChatSessionOptionLabel(descriptor, say)
    const marker = sessionOptionValueMarker(descriptor)
    return [
      <ListRow
        key={descriptor.id}
        title={label}
        value={
          marker === null
            ? undefined
            : marker === 'default'
              ? t('chat.sessionOptionRows.defaultMarker', 'Default')
              : t('chat.sessionOptionRows.notReportedMarker', 'Not reported')
        }
        accessory={
          <MobileSwitch
            accessibilityLabel={label}
            value={descriptor.kind.currentValue}
            onValueChange={(next) => onSetOption(next)}
            disabled={locked}
          />
        }
      />
    ]
  }
  const { currentValue, choices } = descriptor.kind
  return choices.map((choice) => (
    <ListRow
      key={choice.value}
      title={nativeChatSessionChoiceLabel(choice, say, descriptor.id)}
      subtitle={choice.description}
      leading={choiceLeading ? (choiceLeading(choice.value) ?? null) : undefined}
      selected={choice.value === currentValue}
      disabled={locked}
      onPress={() => onSetOption(choice.value)}
    />
  ))
}

export function DescriptorRows(props: DescriptorRowsProps): React.JSX.Element {
  const t = useMobileTranslation()
  return <>{descriptorRowElements(props, t)}</>
}

const styles = themedStyleSheet(() => ({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 38,
    paddingHorizontal: 14,
    borderRadius: radii.pill,
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
  // A footnote under its group, lined up with the row text.
  caption: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingTop: spacing.sm
  },
  value: {
    fontSize: 15,
    flexShrink: 1,
    maxWidth: 180
  }
}))
