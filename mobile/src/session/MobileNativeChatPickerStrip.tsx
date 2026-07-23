import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Package, RotateCcw } from 'lucide-react-native'
import type { NativeChatPickerItem } from '../../../src/shared/native-chat/native-chat-composer-state'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  buildMobileNativeChatPickerPresentation,
  mobileNativeChatPickerAnnotation,
  mobileNativeChatSkillScopeLabel,
  type MobileNativeChatPickerAutocomplete
} from './mobile-native-chat-strip'

const VISIBLE_PICKER_ROWS = 5
const PICKER_ROW_HEIGHT = 52

export function MobileNativeChatPickerStrip({
  autocomplete,
  onChoose,
  onRetry
}: {
  autocomplete: MobileNativeChatPickerAutocomplete
  onChoose: (item: NativeChatPickerItem) => void
  onRetry: () => void
}): React.JSX.Element {
  const presentation = buildMobileNativeChatPickerPresentation(autocomplete)
  return (
    <View style={styles.container}>
      <ScrollView
        keyboardShouldPersistTaps="always"
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        {presentation.showCommandsHeading ? <GroupHeading label="Commands" /> : null}
        {presentation.commands.map((item) => (
          <PickerRow key={item.id} item={item} prefix={autocomplete.prefix} onChoose={onChoose} />
        ))}
        {presentation.showSkillsHeading ? <GroupHeading label="Skills" /> : null}
        {presentation.statusKind === 'loading' ? (
          <StatusRow text={presentation.statusText ?? ''} loading />
        ) : null}
        {presentation.statusKind === 'error' ? (
          <StatusRow
            text={presentation.statusText ?? ''}
            retry={presentation.canRetry ? onRetry : undefined}
          />
        ) : null}
        {presentation.skills.map((item) => (
          <PickerRow key={item.id} item={item} prefix={autocomplete.prefix} onChoose={onChoose} />
        ))}
        {presentation.statusKind === 'empty' ? (
          <StatusRow text={presentation.statusText ?? ''} />
        ) : null}
      </ScrollView>
    </View>
  )
}

function GroupHeading({ label }: { label: string }): React.JSX.Element {
  return <Text style={styles.heading}>{label}</Text>
}

function StatusRow({
  text,
  loading = false,
  retry
}: {
  text: string
  loading?: boolean
  retry?: () => void
}): React.JSX.Element {
  return (
    <View style={styles.status} accessibilityLiveRegion="polite">
      {loading ? <ActivityIndicator size="small" color={colors.textSecondary} /> : null}
      <Text style={styles.statusText}>{text}</Text>
      {retry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry loading skills"
          onPress={retry}
          style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
        >
          <RotateCcw size={14} color={colors.textPrimary} strokeWidth={2} />
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

function PickerRow({
  item,
  prefix,
  onChoose
}: {
  item: NativeChatPickerItem
  prefix: '/' | '$'
  onChoose: (item: NativeChatPickerItem) => void
}): React.JSX.Element {
  const annotation = mobileNativeChatPickerAnnotation(item)
  const scope =
    item.kind === 'skill' ? mobileNativeChatSkillScopeLabel(item.sources[0]?.sourceKind) : ''
  const accessibilityLabel = [prefix + item.name, item.description, scope, annotation]
    .filter(Boolean)
    .join(', ')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => onChoose(item)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {item.kind === 'skill' ? (
        <Package size={16} color={colors.textSecondary} strokeWidth={2} />
      ) : null}
      <View style={styles.rowText}>
        <Text style={styles.token} numberOfLines={1}>
          {prefix + item.name}
        </Text>
        {item.description ? (
          <Text style={styles.description} numberOfLines={1}>
            {item.description}
          </Text>
        ) : null}
        {annotation ? (
          <Text style={styles.annotation} numberOfLines={1}>
            {annotation}
          </Text>
        ) : null}
      </View>
      {scope ? (
        <View style={styles.badge} accessibilityLabel={`${scope} source`}>
          <Text style={styles.badgeText}>{scope}</Text>
        </View>
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  scroll: {
    maxHeight: VISIBLE_PICKER_ROWS * PICKER_ROW_HEIGHT
  },
  scrollContent: {
    paddingVertical: spacing.xs
  },
  heading: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6
  },
  status: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md
  },
  statusText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  retry: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button
  },
  retryText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  row: {
    minHeight: PICKER_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowText: {
    minWidth: 0,
    flex: 1
  },
  token: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  description: {
    marginTop: 2,
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  annotation: {
    marginTop: 2,
    color: colors.textMuted,
    fontSize: 11
  },
  badge: {
    minHeight: 24,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    backgroundColor: colors.bgRaised
  },
  badgeText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '600'
  },
  pressed: {
    opacity: 0.7
  }
})
