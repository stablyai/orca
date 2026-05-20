import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, Pressable, TextInput, StyleSheet, ScrollView, Switch } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { colors, spacing, radii, typography } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'
import {
  buildTerminalShortcutKey,
  normalizeShortcutKeyInput,
  TERMINAL_SHORTCUT_SPECIAL_KEYS,
  type TerminalShortcutModifier
} from '../terminal/terminal-accessory-keys'

export const CUSTOM_ACCESSORY_KEYS_STORAGE_KEY = 'orca:custom-accessory-keys'

export type CustomKey = {
  id: string
  label: string
  bytes: string
  enter: boolean
}

type Step = 'choose-type' | 'shortcut-combo' | 'text-macro'

const SHORTCUT_MODIFIERS: { id: TerminalShortcutModifier; label: string }[] = [
  { id: 'ctrl', label: 'Ctrl' },
  { id: 'alt', label: 'Alt' },
  { id: 'shift', label: 'Shift' }
]

type Props = {
  visible: boolean
  onClose: () => void
  onKeysChanged: (keys: CustomKey[]) => void
}

export async function loadCustomKeys(): Promise<CustomKey[]> {
  try {
    const raw = await AsyncStorage.getItem(CUSTOM_ACCESSORY_KEYS_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as CustomKey[]) : []
  } catch {
    return []
  }
}

export async function saveCustomKeys(keys: CustomKey[]): Promise<void> {
  await AsyncStorage.setItem(CUSTOM_ACCESSORY_KEYS_STORAGE_KEY, JSON.stringify(keys))
}

export function CustomKeyModal({ visible, onClose, onKeysChanged }: Props) {
  const [step, setStep] = useState<Step>('choose-type')
  const [shortcutKey, setShortcutKey] = useState('c')
  const [shortcutModifiers, setShortcutModifiers] = useState<TerminalShortcutModifier[]>(['ctrl'])
  const [macroLabel, setMacroLabel] = useState('')
  const [macroText, setMacroText] = useState('')
  const [macroEnter, setMacroEnter] = useState(true)

  useEffect(() => {
    if (visible) {
      setStep('choose-type')
      setShortcutKey('c')
      setShortcutModifiers(['ctrl'])
      setMacroLabel('')
      setMacroText('')
      setMacroEnter(true)
    }
  }, [visible])

  const addKey = useCallback(
    async (key: Omit<CustomKey, 'id'>) => {
      const existing = await loadCustomKeys()
      const newKey: CustomKey = { ...key, id: `custom-${Date.now()}` }
      const updated = [...existing, newKey]
      await saveCustomKeys(updated)
      onKeysChanged(updated)
      onClose()
    },
    [onClose, onKeysChanged]
  )

  const shortcutPreview = useMemo(
    () => buildTerminalShortcutKey({ key: shortcutKey, modifiers: shortcutModifiers }),
    [shortcutKey, shortcutModifiers]
  )

  const toggleShortcutModifier = useCallback((modifier: TerminalShortcutModifier) => {
    setShortcutModifiers((current) =>
      current.includes(modifier)
        ? current.filter((item) => item !== modifier)
        : [...current, modifier]
    )
  }, [])

  const handleShortcutKeyInput = useCallback((value: string) => {
    const next = normalizeShortcutKeyInput(value)
    if (next) {
      setShortcutKey(next)
    }
  }, [])

  const handleShortcutSave = useCallback(() => {
    const built = buildTerminalShortcutKey({ key: shortcutKey, modifiers: shortcutModifiers })
    if (!built) return
    void addKey({ label: built.label, bytes: built.bytes, enter: false })
  }, [addKey, shortcutKey, shortcutModifiers])

  const handleMacroSave = useCallback(() => {
    const label = macroLabel.trim() || macroText.trim().slice(0, 12)
    const text = macroText
    if (!label || !text) return
    const bytes = macroEnter ? `${text}\r` : text
    void addKey({ label, bytes, enter: false })
  }, [addKey, macroLabel, macroText, macroEnter])

  const showBack = step !== 'choose-type'

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <View style={styles.header}>
        {showBack ? (
          <Pressable
            style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
            onPress={() => setStep('choose-type')}
            accessibilityLabel="Back"
          >
            <ChevronLeft size={18} color={colors.textSecondary} />
          </Pressable>
        ) : (
          <View style={styles.backSpacer} />
        )}
        <Text style={styles.title}>
          {step === 'choose-type' && 'Add Shortcut'}
          {step === 'shortcut-combo' && 'Shortcut Combo'}
          {step === 'text-macro' && 'Text Macro'}
        </Text>
        <View style={styles.backSpacer} />
      </View>

      {step === 'choose-type' && (
        <View style={styles.group}>
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setStep('shortcut-combo')}
          >
            <Text style={styles.rowLabel}>Shortcut Combo</Text>
            <Text style={styles.rowHint}>Build Ctrl, Alt, and Shift key chords</Text>
          </Pressable>
          <View style={styles.separator} />
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setStep('text-macro')}
          >
            <Text style={styles.rowLabel}>Text Macro</Text>
            <Text style={styles.rowHint}>Send custom text command</Text>
          </Pressable>
        </View>
      )}

      {step === 'shortcut-combo' && (
        <View style={styles.group}>
          <View style={styles.shortcutForm}>
            <Text style={styles.fieldLabel}>Modifiers</Text>
            <View style={styles.modifierRow}>
              {SHORTCUT_MODIFIERS.map((modifier) => {
                const selected = shortcutModifiers.includes(modifier.id)
                return (
                  <Pressable
                    key={modifier.id}
                    style={({ pressed }) => [
                      styles.modifierPill,
                      selected && styles.modifierPillSelected,
                      pressed && styles.modifierPillPressed
                    ]}
                    onPress={() => toggleShortcutModifier(modifier.id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                  >
                    <Text
                      style={[styles.modifierPillText, selected && styles.modifierPillTextSelected]}
                    >
                      {modifier.label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>

            <Text style={styles.fieldLabel}>Key</Text>
            <TextInput
              style={styles.fieldInput}
              value={shortcutKey.length === 1 ? shortcutKey.toUpperCase() : ''}
              onChangeText={handleShortcutKeyInput}
              placeholder="C"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={1}
            />

            <Text style={styles.fieldLabel}>Special Keys</Text>
            <ScrollView style={styles.keyGridScroll} contentContainerStyle={styles.keyGrid}>
              {TERMINAL_SHORTCUT_SPECIAL_KEYS.map((key) => {
                const selected = shortcutKey === key.id
                return (
                  <Pressable
                    key={key.id}
                    style={({ pressed }) => [
                      styles.keyCell,
                      selected && styles.keyCellSelected,
                      pressed && styles.keyCellPressed
                    ]}
                    onPress={() => setShortcutKey(key.id)}
                    accessibilityLabel={key.accessibilityLabel}
                    accessibilityState={{ selected }}
                  >
                    <Text style={[styles.keyCellText, selected && styles.keyCellTextSelected]}>
                      {key.label}
                    </Text>
                  </Pressable>
                )
              })}
            </ScrollView>

            <View style={styles.previewRow}>
              <Text style={styles.previewLabel}>Preview</Text>
              <Text style={styles.previewValue}>{shortcutPreview?.label ?? 'Unsupported'}</Text>
            </View>
            <Pressable
              style={[styles.saveButton, !shortcutPreview && styles.saveButtonDisabled]}
              disabled={!shortcutPreview}
              onPress={handleShortcutSave}
            >
              <Text style={styles.saveButtonText}>Add Shortcut</Text>
            </Pressable>
          </View>
        </View>
      )}

      {step === 'text-macro' && (
        <View style={styles.group}>
          <View style={styles.macroForm}>
            <Text style={styles.fieldLabel}>Label</Text>
            <TextInput
              style={styles.fieldInput}
              value={macroLabel}
              onChangeText={setMacroLabel}
              placeholder="e.g. Build"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.fieldLabel}>Command</Text>
            <TextInput
              style={styles.fieldInput}
              value={macroText}
              onChangeText={setMacroText}
              placeholder="e.g. pnpm build"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Press Enter</Text>
              <Switch
                value={macroEnter}
                onValueChange={setMacroEnter}
                trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
                thumbColor={colors.textPrimary}
              />
            </View>
            <Pressable
              style={[styles.saveButton, !macroText.trim() && styles.saveButtonDisabled]}
              disabled={!macroText.trim()}
              onPress={handleMacroSave}
            >
              <Text style={styles.saveButtonText}>Add Shortcut</Text>
            </Pressable>
          </View>
        </View>
      )}
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: spacing.sm
  },
  backButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center'
  },
  backButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  backSpacer: {
    width: 30
  },
  title: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    textAlign: 'center'
  },
  group: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  row: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowLabel: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary,
    marginBottom: 1
  },
  rowHint: {
    fontSize: 12,
    color: colors.textMuted
  },
  shortcutForm: {
    padding: spacing.md,
    gap: spacing.sm
  },
  modifierRow: {
    flexDirection: 'row',
    gap: spacing.xs
  },
  modifierPill: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgBase,
    borderRadius: radii.button,
    paddingVertical: spacing.sm,
    alignItems: 'center'
  },
  modifierPillSelected: {
    backgroundColor: colors.textPrimary,
    borderColor: colors.textPrimary
  },
  modifierPillPressed: {
    backgroundColor: colors.bgRaised
  },
  modifierPillText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  modifierPillTextSelected: {
    color: colors.bgBase
  },
  keyGridScroll: {
    maxHeight: 154
  },
  keyGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    justifyContent: 'center',
    paddingVertical: spacing.xs
  },
  keyCell: {
    minWidth: 42,
    height: 38,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.button,
    backgroundColor: colors.bgBase,
    alignItems: 'center',
    justifyContent: 'center'
  },
  keyCellPressed: {
    backgroundColor: colors.bgRaised
  },
  keyCellSelected: {
    backgroundColor: colors.textPrimary
  },
  keyCellText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    fontFamily: typography.monoFamily
  },
  keyCellTextSelected: {
    color: colors.bgBase
  },
  macroForm: {
    padding: spacing.md,
    gap: spacing.sm
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary
  },
  fieldInput: {
    backgroundColor: colors.bgBase,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    fontFamily: typography.monoFamily,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.bgBase,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  previewLabel: {
    fontSize: 13,
    color: colors.textSecondary
  },
  previewValue: {
    fontSize: 14,
    fontFamily: typography.monoFamily,
    color: colors.textPrimary
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs
  },
  switchLabel: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  saveButton: {
    backgroundColor: colors.textPrimary,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button,
    alignItems: 'center'
  },
  saveButtonDisabled: {
    opacity: 0.5
  },
  saveButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
})
