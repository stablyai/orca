import { useState, useEffect, useCallback } from 'react'
import { View, Text, Pressable, TextInput, StyleSheet, ScrollView, Switch } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { colors, spacing, radii, typography } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'

const STORAGE_KEY = 'orca:custom-accessory-keys'

export type CustomKey = {
  id: string
  label: string
  bytes: string
  enter: boolean
}

type Step = 'choose-type' | 'pick-ctrl' | 'pick-alt' | 'text-macro'

const ALPHA_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

function ctrlBytes(letter: string): string {
  return String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64)
}

function altBytes(letter: string): string {
  return `\x1b${letter.toLowerCase()}`
}

type Props = {
  visible: boolean
  onClose: () => void
  onKeysChanged: (keys: CustomKey[]) => void
}

export async function loadCustomKeys(): Promise<CustomKey[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as CustomKey[]) : []
  } catch {
    return []
  }
}

async function saveCustomKeys(keys: CustomKey[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(keys))
}

export function CustomKeyModal({ visible, onClose, onKeysChanged }: Props) {
  const [step, setStep] = useState<Step>('choose-type')
  const [macroLabel, setMacroLabel] = useState('')
  const [macroText, setMacroText] = useState('')
  const [macroEnter, setMacroEnter] = useState(true)

  useEffect(() => {
    if (visible) {
      setStep('choose-type')
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

  const handleCtrlKey = useCallback(
    (letter: string) => {
      void addKey({ label: `Ctrl+${letter}`, bytes: ctrlBytes(letter), enter: false })
    },
    [addKey]
  )

  const handleAltKey = useCallback(
    (letter: string) => {
      void addKey({ label: `Alt+${letter}`, bytes: altBytes(letter), enter: false })
    },
    [addKey]
  )

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
          {step === 'pick-ctrl' && 'Ctrl + Key'}
          {step === 'pick-alt' && 'Alt + Key'}
          {step === 'text-macro' && 'Text Macro'}
        </Text>
        <View style={styles.backSpacer} />
      </View>

      {step === 'choose-type' && (
        <View style={styles.group}>
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setStep('pick-ctrl')}
          >
            <Text style={styles.rowLabel}>Ctrl + Key</Text>
            <Text style={styles.rowHint}>Control character shortcuts</Text>
          </Pressable>
          <View style={styles.separator} />
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setStep('pick-alt')}
          >
            <Text style={styles.rowLabel}>Alt + Key</Text>
            <Text style={styles.rowHint}>Alt/Option key combos</Text>
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

      {(step === 'pick-ctrl' || step === 'pick-alt') && (
        <View style={styles.group}>
          <ScrollView style={styles.keyGridScroll} contentContainerStyle={styles.keyGrid}>
            {ALPHA_KEYS.map((letter) => (
              <Pressable
                key={letter}
                style={({ pressed }) => [styles.keyCell, pressed && styles.keyCellPressed]}
                onPress={() =>
                  step === 'pick-ctrl' ? handleCtrlKey(letter) : handleAltKey(letter)
                }
              >
                <Text style={styles.keyCellText}>{letter}</Text>
              </Pressable>
            ))}
          </ScrollView>
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
  keyGridScroll: {
    maxHeight: 240
  },
  keyGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    justifyContent: 'center',
    padding: spacing.md
  },
  keyCell: {
    width: 42,
    height: 38,
    borderRadius: radii.button,
    backgroundColor: colors.bgBase,
    alignItems: 'center',
    justifyContent: 'center'
  },
  keyCellPressed: {
    backgroundColor: colors.bgRaised
  },
  keyCellText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    fontFamily: typography.monoFamily
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
