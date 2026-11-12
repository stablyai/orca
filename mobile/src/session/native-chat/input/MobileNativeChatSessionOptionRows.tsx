import type { ReactElement, ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ShieldAlert, type LucideIcon } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { Translate } from '../../../i18n/mobile-i18n'
import { LIST_ROW_PADDING, ListRow } from '../../../components/list/ListGroup'
import {
  sessionOptionValueMarker,
  type SessionOptionDescriptor,
  type SessionOptionValue
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  nativeChatSessionChoiceLabel,
  nativeChatSessionOptionActionLabel,
  nativeChatSessionOptionLabel
} from '../../../../../src/shared/native-chat/input/native-chat-session-option-labels'
import {
  loneFastTier,
  speedButtonTiers
} from '../../../../../src/shared/native-chat/input/native-chat-session-speed-tiers'
import { sayMobileNativeChatSessionOption as say } from './native-chat-session-option-copy'
import { MobileSwitch } from '../../../components/MobileSwitch'
import { nativeChatModelSearchScore } from '../../../../../src/shared/native-chat/input/native-chat-model-search'

export function SessionOptionCaption({ children }: { children: string }): React.JSX.Element {
  useMobileColorScheme()
  return <Text style={styles.caption}>{children}</Text>
}

export function ModelPill({
  primary,
  secondary,
  warning,
  icon: Icon,
  leading,
  accessibleName,
  disabled,
  onPress
}: {
  primary: string
  secondary: string | null
  warning: boolean
  icon?: LucideIcon
  /** Shown before the label, unlike `icon`, which replaces it. */
  leading?: LucideIcon
  accessibleName: string
  disabled: boolean
  onPress: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  // A held pick's clock never hides the full-access warning.
  const PillIcon = Icon ?? (warning ? ShieldAlert : leading)
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
  query?: string
  /** Whether search-only choices are revealed; without it they stay off the list. */
  moreChoices?: { shown: boolean; onToggle: () => void }
}

/** A Fast-only speed, which toggles on one row like Claude's Fast mode. */
function fastSpeedSwitch(descriptor: SessionOptionDescriptor) {
  const speed = speedButtonTiers(descriptor)
  const fast = speed ? loneFastTier(speed.tiers) : undefined
  return speed && fast ? { standard: speed.standard, fast } : null
}

export function showsSessionOptionAsSwitch(descriptor: SessionOptionDescriptor): boolean {
  return (
    !descriptor.action &&
    (descriptor.kind.type === 'boolean' || fastSpeedSwitch(descriptor) !== null)
  )
}

/** One descriptor's rows as an array, so a ListGroup can draw the separators between them. */
export function descriptorRowElements(
  {
    descriptor,
    disabled,
    onSetOption,
    onInvokeAction,
    choiceLeading,
    query,
    moreChoices
  }: DescriptorRowsProps,
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
  const fastSpeed = fastSpeedSwitch(descriptor)
  if (descriptor.kind.type === 'boolean' || fastSpeed) {
    const { kind } = descriptor
    const label = fastSpeed ? say('fastMode') : nativeChatSessionOptionLabel(descriptor, say)
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
            value={
              kind.type === 'boolean'
                ? kind.currentValue
                : kind.currentValue === fastSpeed?.fast.value
            }
            onValueChange={(next) =>
              onSetOption(
                fastSpeed ? (next ? fastSpeed.fast.value : fastSpeed.standard.value) : next
              )
            }
            disabled={locked}
          />
        }
      />
    ]
  }
  const { currentValue, choices } = descriptor.kind
  const choiceRow = (choice: (typeof choices)[number]) => (
    <ListRow
      key={choice.value}
      title={nativeChatSessionChoiceLabel(choice, say, descriptor.id)}
      subtitle={choice.description}
      leading={choiceLeading ? (choiceLeading(choice.value) ?? null) : undefined}
      selected={choice.value === currentValue}
      disabled={locked}
      onPress={() => onSetOption(choice.value)}
    />
  )
  const terms = query?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
  if (query !== undefined) {
    return choices
      .filter((choice) => {
        if (choice.searchOnly && terms.length === 0) {
          return false
        }
        return (
          nativeChatModelSearchScore(choice.value, query, [
            nativeChatSessionChoiceLabel(choice, say, descriptor.id),
            choice.description ?? ''
          ]) > 0
        )
      })
      .map(choiceRow)
  }
  const more = moreChoices ? choices.filter((choice) => choice.searchOnly) : []
  return [
    ...choices.filter((choice) => !choice.searchOnly).map(choiceRow),
    ...(more.length > 0 && moreChoices
      ? [
          <ListRow
            key="more-choices"
            title={
              moreChoices.shown
                ? t('chat.sessionOptionRows.fewerModels', 'Fewer models')
                : t('chat.sessionOptionRows.moreModels', 'More models')
            }
            onPress={moreChoices.onToggle}
          />,
          ...(moreChoices.shown ? more.map(choiceRow) : [])
        ]
      : [])
  ]
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
