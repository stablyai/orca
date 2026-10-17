import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import type { CustomKey } from './CustomKeyModal'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { terminalSettingsScreenStyles as baseStyles } from '../terminal/terminal-settings-screen-styles'
import type { TerminalAccessoryKey } from '../terminal/terminal-accessory-keys'

export type TerminalShortcutReorderItem =
  | { kind: 'built-in'; id: string; shortcutKey: TerminalAccessoryKey }
  | { kind: 'custom'; id: string; customKey: CustomKey }

type Props = {
  item: TerminalShortcutReorderItem
  canEdit: boolean
  builtInVisible: boolean
  onToggleBuiltIn: (visible: boolean) => void
  onDeleteCustom: () => void
  onEditCustom: (customKey: CustomKey) => void
}

export function TerminalShortcutReorderRow({
  item,
  canEdit,
  builtInVisible,
  onToggleBuiltIn,
  onDeleteCustom,
  onEditCustom
}: Props): React.JSX.Element {
  const identity = <ShortcutIdentity item={item} />
  return (
    <View style={styles.reorderRowContent}>
      {item.kind === 'custom' ? (
        <Pressable
          disabled={!canEdit}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${item.customKey.label}`}
          onPress={() => onEditCustom(item.customKey)}
          style={({ pressed }) => [
            styles.editTarget,
            pressed && canEdit && styles.editTargetPressed
          ]}
        >
          {identity}
        </Pressable>
      ) : (
        <View style={styles.editTarget}>{identity}</View>
      )}
      {item.kind === 'built-in' ? (
        <Switch
          disabled={!canEdit}
          value={builtInVisible}
          onValueChange={onToggleBuiltIn}
          trackColor={{ false: colors.borderSubtle, true: colors.textSecondary }}
          thumbColor={colors.textPrimary}
        />
      ) : (
        <Pressable
          disabled={!canEdit}
          style={({ pressed }) => [
            styles.deleteButton,
            pressed && canEdit && styles.deleteButtonPressed,
            !canEdit && styles.disabled
          ]}
          onPress={onDeleteCustom}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${item.customKey.label}`}
        >
          <X size={16} color={colors.statusRed} />
        </Pressable>
      )}
    </View>
  )
}

function ShortcutIdentity({ item }: { item: TerminalShortcutReorderItem }): React.JSX.Element {
  const keycapLabel = item.kind === 'built-in' ? item.shortcutKey.label : item.customKey.label
  const title =
    item.kind === 'built-in'
      ? (item.shortcutKey.accessibilityLabel ?? item.shortcutKey.label)
      : item.customKey.label
  return (
    <>
      <View style={styles.keycap}>
        <Text style={styles.keycapText}>{keycapLabel}</Text>
      </View>
      <View style={baseStyles.rowContent}>
        <Text style={baseStyles.rowLabel}>{title}</Text>
        {item.kind === 'custom' ? (
          <Text style={baseStyles.rowSublabel} numberOfLines={1} ellipsizeMode="tail">
            {item.customKey.bytes.replace(/\r/g, ' ↵')}
          </Text>
        ) : null}
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  reorderRowContent: {
    flex: 1,
    height: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingLeft: spacing.md + 2
  },
  editTarget: {
    flex: 1,
    height: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2
  },
  editTargetPressed: {
    backgroundColor: colors.bgRaised
  },
  keycap: {
    minWidth: 62,
    alignItems: 'center',
    backgroundColor: colors.bgRaised,
    borderRadius: radii.button,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  keycapText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  },
  deleteButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.1)'
  },
  deleteButtonPressed: { backgroundColor: 'rgba(239, 68, 68, 0.2)' },
  disabled: { opacity: 0.35 }
})
