import type { ReactElement, ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown, ShieldAlert, type LucideIcon } from 'lucide-react-native'
import { pressedStyle, radii, spacing, typography } from '../../../../theme/mobile-theme'
import { COMPOSER_CONTROL_SIZE } from '../../../../components/composer-input/composer-input-styles'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'
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
  nativeChatSessionOptionActionLabel,
  nativeChatSessionOptionLabel
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-labels'
import {
  loneFastTier,
  speedButtonTiers
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-speed-tiers'
import { mobileNativeChatSessionOptionSay } from './native-chat-session-option-copy'
import { mobileSessionOptionChoiceCopy } from './mobile-native-chat-session-option-labels'
import { orderEffortLevels } from '../../../../../../src/shared/agent-session/options/view/effort-level-order'
import { MobileSwitch } from '../../../../components/controls/MobileSwitch'

export function SessionOptionCaption({ children }: { children: string }): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  return <Text style={styles.caption}>{children}</Text>
}

export function SessionOptionLockCaption(): React.JSX.Element {
  const t = useMobileTranslation()
  return (
    <SessionOptionCaption>
      {t(
        'chat.sessionOptionPickers.settingsLocked',
        'Model settings unlock when this turn finishes.'
      )}
    </SessionOptionCaption>
  )
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
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
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
  const styles = useThemedStyles(stylesSheet)
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

type MoreChoices = { shown: boolean; onToggle: () => void }

type SelectRowProps = {
  disabled: boolean
  onSetOption: (value: SessionOptionValue) => void
  /** A leading mark per choice, as each permission mode has its icon. */
  choiceLeading?: (value: string) => ReactNode
  /** Whether search-only choices are revealed; without it they stay off the list. */
  moreChoices?: MoreChoices
}

type DescriptorRowsProps = SelectRowProps & {
  descriptor: SessionOptionDescriptor
  onInvokeAction: () => void
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
    moreChoices
  }: DescriptorRowsProps,
  t: Translate
): ReactElement[] {
  const say = mobileNativeChatSessionOptionSay(t)
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
  return browsedSelectItems(descriptor, moreChoices).map((item) =>
    selectItemRow(descriptor, item, { disabled, onSetOption, choiceLeading, moreChoices }, t)
  )
}

const MORE_CHOICES = 'more-choices'
/** A row of a select's list: one of its choices, or the More models toggle. */
export type SelectListItem = SessionOptionSelectChoice | typeof MORE_CHOICES

export function selectListItemKey(item: SelectListItem): string {
  return item === MORE_CHOICES ? MORE_CHOICES : item.value
}

/** A select's list while browsing: search-only choices stay out; folded ones follow a More models toggle. */
export function browsedSelectItems(
  descriptor: SessionOptionDescriptor,
  moreChoices?: MoreChoices
): SelectListItem[] {
  const { kind } = descriptor
  if (kind.type !== 'select') {
    return []
  }
  // A provider fallback is what runs, so the saved model stays pickable.
  const currentValue = descriptor.fallbackModel ?? kind.currentValue
  const choices =
    descriptor.category === 'thought_level' ? orderEffortLevels(kind.choices) : kind.choices
  const listed = choices.filter(
    (choice) =>
      !choice.hidden || choice.value === currentValue || choice.value === kind.currentValue
  )
  const more = moreChoices ? listed.filter((choice) => choice.legacy) : []
  const folded: SelectListItem[] =
    more.length > 0 && moreChoices ? [...(moreChoices.shown ? more : []), MORE_CHOICES] : []
  return [...listed.filter((choice) => !choice.legacy), ...folded]
}

/** One row of a select's list: a choice, checked when it is the one running, or the More models toggle. */
export function selectItemRow(
  descriptor: SessionOptionDescriptor,
  item: SelectListItem,
  { disabled, onSetOption, choiceLeading, moreChoices }: SelectRowProps,
  t: Translate
): ReactElement {
  if (item === MORE_CHOICES) {
    return (
      <ListRow
        key={MORE_CHOICES}
        title={
          moreChoices?.shown
            ? t('chat.sessionOptionRows.fewerModels', 'Fewer models')
            : t('chat.sessionOptionRows.moreModels', 'More models')
        }
        onPress={moreChoices?.onToggle}
      />
    )
  }
  const { kind } = descriptor
  // An unreported effort marks nothing, rather than reading as a confirmed choice.
  const marked =
    kind.type !== 'select' ||
    (descriptor.category === 'thought_level' && descriptor.valueSource === 'unknown')
      ? undefined
      : (descriptor.fallbackModel ?? kind.currentValue)
  const copy = mobileSessionOptionChoiceCopy(descriptor, item, t)
  return (
    <ListRow
      key={item.value}
      title={copy.label}
      subtitle={copy.description}
      leading={choiceLeading ? (choiceLeading(item.value) ?? null) : undefined}
      selected={item.value === marked}
      disabled={disabled || !descriptor.settable}
      onPress={() => onSetOption(item.value)}
    />
  )
}

export function DescriptorRows(props: DescriptorRowsProps): React.JSX.Element {
  const t = useMobileTranslation()
  return <>{descriptorRowElements(props, t)}</>
}

const stylesSheet = themedStyleSheet((colors) => ({
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
