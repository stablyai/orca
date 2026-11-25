import type { ReactElement, ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown, ShieldAlert, type LucideIcon } from 'lucide-react-native'
import { colors, pressedStyle, radii, spacing, typography } from '../../../../theme/mobile-theme'
import { COMPOSER_CONTROL_SIZE } from '../../../../components/composer-input/composer-input-styles'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { LIST_ROW_PADDING, ListRow } from '../../../../components/list/ListGroup'
import {
  sessionOptionValueMarker,
  type SessionOptionDescriptor,
  type SessionOptionSelectChoice,
  type SessionOptionValue
} from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  nativeChatSessionChoiceLabel,
  nativeChatSessionOptionActionLabel,
  nativeChatSessionOptionLabel
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-labels'
import {
  loneFastTier,
  speedButtonTiers
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-speed-tiers'
import { nativeChatModelSearchMatcher } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-model-search'
import { sayMobileNativeChatSessionOption as say } from './native-chat-session-option-copy'
import { orderEffortLevels } from '../../../../../../src/shared/agent-session/options/view/effort-level-order'
import { MobileSwitch } from '../../../../components/controls/MobileSwitch'

export function SessionOptionCaption({ children }: { children: string }): React.JSX.Element {
  useMobileColorScheme()
  return <Text style={styles.caption}>{children}</Text>
}

/** One target for the chat's options: the model's name (or a value), with Full access's shield. */
export function ModelPill({
  primary,
  warning,
  icon: Icon,
  leading,
  accessibleName,
  disabled,
  onPress
}: {
  primary: string
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
        <Text
          style={[styles.pillText, disabled && styles.pillTextDisabled]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {primary}
        </Text>
      ) : null}
      <ChevronDown size={14} color={colors.textMuted} strokeWidth={2.2} />
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
  subtitle,
  accessibleValue,
  valueColor,
  disabled,
  onPress
}: {
  label: string
  value: string
  /** Wraps under the label, for context too long for the one-line value. */
  subtitle?: string
  accessibleValue?: string
  valueColor?: string
  disabled: boolean
  onPress?: () => void
}): React.JSX.Element {
  const tinted = valueColor ? <TintedValue value={value} color={valueColor} /> : undefined
  const row = (
    <ListRow
      title={label}
      subtitle={subtitle}
      value={tinted ? undefined : value}
      accessory={tinted}
      navigates={onPress !== undefined}
      onPress={onPress}
      disabled={onPress !== undefined && disabled}
      accessibilityLabel={`${label}, ${accessibleValue ?? value}`}
    />
  )
  if (onPress) {
    return row
  }
  return (
    <View accessible accessibilityLabel={`${label}, ${accessibleValue ?? value}`}>
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
  /** Whether search-only choices are revealed; without it they stay off the list. */
  moreChoices?: { shown: boolean; onToggle: () => void }
  /** The model list's search: every match, search-only and folded ones included. */
  query?: string
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
    moreChoices,
    query = ''
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
  // A provider fallback is what runs, so the saved model stays pickable.
  const currentValue = descriptor.fallbackModel ?? descriptor.kind.currentValue
  // An unreported effort marks nothing, rather than reading as a confirmed choice.
  const marked =
    descriptor.category === 'thought_level' && descriptor.valueSource === 'unknown'
      ? undefined
      : currentValue
  const choices =
    descriptor.category === 'thought_level'
      ? orderEffortLevels(descriptor.kind.choices)
      : descriptor.kind.choices
  const choiceRow = (choice: (typeof choices)[number]) => (
    <ListRow
      key={choice.value}
      title={nativeChatSessionChoiceLabel(choice, say, descriptor.id)}
      subtitle={choice.description}
      leading={choiceLeading ? (choiceLeading(choice.value) ?? null) : undefined}
      selected={choice.value === marked}
      disabled={locked}
      onPress={() => onSetOption(choice.value)}
    />
  )
  const searched = searchedChoices(descriptor, query)
  if (searched) {
    return searched.map(choiceRow)
  }
  // Browsing, search-only rows stay out; folded ones follow a More models toggle.
  const listed = choices.filter(
    (choice) =>
      !choice.hidden ||
      choice.value === currentValue ||
      choice.value === descriptor.kind.currentValue
  )
  const more = moreChoices ? listed.filter((choice) => choice.legacy) : []
  return [
    ...listed.filter((choice) => !choice.legacy).map(choiceRow),
    ...(more.length > 0 && moreChoices
      ? [
          ...(moreChoices.shown ? more.map(choiceRow) : []),
          <ListRow
            key="more-choices"
            title={
              moreChoices.shown
                ? t('chat.sessionOptionRows.fewerModels', 'Fewer models')
                : t('chat.sessionOptionRows.moreModels', 'More models')
            }
            onPress={moreChoices.onToggle}
          />
        ]
      : [])
  ]
}

/** A select's choices matching `query` by id, label or description, in the host's order; null for no search. */
export function searchedChoices(
  descriptor: SessionOptionDescriptor,
  query: string
): SessionOptionSelectChoice[] | null {
  const matches = nativeChatModelSearchMatcher(query)
  if (!matches || descriptor.kind.type !== 'select') {
    return null
  }
  return descriptor.kind.choices.filter((choice) =>
    matches([
      choice.value,
      nativeChatSessionChoiceLabel(choice, say, descriptor.id),
      choice.description ?? ''
    ])
  )
}

export function DescriptorRows(props: DescriptorRowsProps): React.JSX.Element {
  const t = useMobileTranslation()
  return <>{descriptorRowElements(props, t)}</>
}

const styles = themedStyleSheet(() => ({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    maxWidth: '100%',
    height: COMPOSER_CONTROL_SIZE,
    paddingLeft: 14,
    paddingRight: 10,
    borderRadius: radii.pill,
    backgroundColor: colors.composerControl
  },
  pillText: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  pillTextDisabled: {
    color: colors.textMuted
  },
  pressed: pressedStyle,
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
