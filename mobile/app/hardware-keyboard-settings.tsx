import { useCallback, useMemo, useState } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft, ChevronRight } from 'lucide-react-native'
import {
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  getKeybindingDefinition,
  type TerminalShortcutPolicy
} from '../../src/shared/keybindings'
import { PickerModal, type PickerOption } from '../src/components/PickerModal'
import { MOBILE_HARDWARE_KEYBOARD_ACTIONS } from '../src/hardware-keyboard/mobile-hardware-keyboard-actions'
import { saveMobileTerminalShortcutPolicy } from '../src/hardware-keyboard/mobile-hardware-keyboard-preferences'
import { useMobileHardwareKeyboardPreferences } from '../src/hardware-keyboard/use-mobile-hardware-keyboard-preferences'
import { colors, radii, spacing, typography } from '../src/theme/mobile-theme'

const POLICY_OPTIONS: PickerOption<TerminalShortcutPolicy>[] = [
  {
    value: 'orca-first',
    label: 'Orca first',
    subtitle: 'Navigation shortcuts switch Orca even while the terminal has focus.'
  },
  {
    value: 'terminal-first',
    label: 'Terminal first',
    subtitle: 'Only terminal-safe navigation shortcuts are captured over a focused terminal.'
  }
]

export default function HardwareKeyboardSettingsScreen(): React.JSX.Element {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const preferences = useMobileHardwareKeyboardPreferences()
  const [policyPickerOpen, setPolicyPickerOpen] = useState(false)
  const [policySaveError, setPolicySaveError] = useState<string | null>(null)
  const platform = Platform.OS === 'ios' ? 'darwin' : 'linux'
  const groups = useMemo(() => {
    const result = new Map<string, (typeof MOBILE_HARDWARE_KEYBOARD_ACTIONS)[number][]>()
    for (const actionId of MOBILE_HARDWARE_KEYBOARD_ACTIONS) {
      const group = getKeybindingDefinition(actionId)?.group ?? 'Navigation'
      const current = result.get(group) ?? []
      current.push(actionId)
      result.set(group, current)
    }
    return [...result]
  }, [])

  const policyLabel =
    POLICY_OPTIONS.find((option) => option.value === preferences.terminalShortcutPolicy)?.label ??
    POLICY_OPTIONS[0]!.label

  const handlePolicySelect = useCallback(async (value: TerminalShortcutPolicy) => {
    setPolicySaveError(null)
    try {
      await saveMobileTerminalShortcutPolicy(value)
    } catch {
      setPolicySaveError('Could not save keyboard preference. Try again.')
    }
  }, [])

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Hardware Keyboard</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.groupHeading}>TERMINAL</Text>
        <Text style={styles.groupDescription}>
          Choose whether Orca navigation or the shell owns conflicting shortcuts.
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setPolicyPickerOpen(true)}
          >
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Shortcuts in terminal</Text>
              <Text style={styles.rowSublabel}>{policyLabel}</Text>
            </View>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
        </View>
        {policySaveError ? <Text style={styles.error}>{policySaveError}</Text> : null}

        {groups.map(([group, actionIds]) => (
          <View key={group} style={styles.shortcutGroup}>
            <Text style={styles.groupHeading}>{group.toUpperCase()}</Text>
            <View style={styles.section}>
              {actionIds.map((actionId, index) => {
                const definition = getKeybindingDefinition(actionId)
                if (!definition) {
                  return null
                }
                const label = formatKeybindingList(
                  getEffectiveKeybindingsForAction(actionId, platform),
                  platform
                )
                return (
                  <View key={actionId}>
                    {index > 0 ? <View style={styles.separator} /> : null}
                    <View style={styles.shortcutRow}>
                      <Text style={styles.rowLabel}>{definition.title}</Text>
                      <Text style={styles.shortcutLabel}>{label}</Text>
                    </View>
                  </View>
                )
              })}
            </View>
          </View>
        ))}
      </ScrollView>

      <PickerModal<TerminalShortcutPolicy>
        visible={policyPickerOpen}
        title="Shortcuts in terminal"
        options={POLICY_OPTIONS}
        selected={preferences.terminalShortcutPolicy}
        onSelect={(value) => void handlePolicySelect(value)}
        onClose={() => setPolicyPickerOpen(false)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.lg
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.lg
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary
  },
  groupHeading: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  groupDescription: {
    fontSize: typography.bodySize - 1,
    color: colors.textSecondary,
    lineHeight: 20,
    paddingHorizontal: spacing.xs
  },
  error: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xs
  },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    overflow: 'hidden'
  },
  sectionTopGap: {
    marginTop: spacing.sm
  },
  shortcutGroup: {
    marginTop: spacing.xl
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowContent: {
    flex: 1
  },
  rowLabel: {
    flex: 1,
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  rowSublabel: {
    fontSize: typography.bodySize - 2,
    color: colors.textSecondary,
    marginTop: 2
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  shortcutRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md + 2
  },
  shortcutLabel: {
    maxWidth: '48%',
    textAlign: 'right',
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily,
    color: colors.textSecondary
  }
})
