import { useCallback, useMemo, useState } from 'react'
import { View, Text, Pressable, TextInput, StyleSheet, Switch } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { colors, spacing, radii, typography } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'
import {
  buildTerminalShortcutKey,
  normalizeShortcutKeyInput,
  TERMINAL_SHORTCUT_SPECIAL_KEYS,
  TERMINAL_SHORTCUT_MODIFIER_LABELS,
  type TerminalShortcutModifier,
  type TerminalShortcutSpecialKey
} from '../terminal/terminal-accessory-keys'
import { t } from '@/i18n/mobile-i18n'

const CUSTOM_ACCESSORY_KEYS_STORAGE_KEY = 'orca:custom-accessory-keys'

export type CustomKey = {
  id: string
  label: string
  bytes: string
}

type Step = 'choose-type' | 'shortcut-combo' | 'special-keys' | 'text-macro'

// Why: Alt is rendered with the ⌥ glyph because on macOS hosts the Option key
// is the only modifier that produces an ESC-prefixed byte sequence terminals
// can read. Cmd is intentionally absent — macOS swallows it before keystrokes
// reach the shell, so there's nothing to encode.
const SPECIAL_KEY_BY_ID: Record<string, TerminalShortcutSpecialKey> = Object.fromEntries(
  TERMINAL_SHORTCUT_SPECIAL_KEYS.map((key) => [key.id, key])
)

type Props = {
  visible: boolean
  onClose: () => void
  onKeysChanged: (keys: CustomKey[]) => void
  onManageShortcuts?: () => void
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

export function CustomKeyModal({ visible, onClose, onKeysChanged, onManageShortcuts }: Props) {
  const [step, setStep] = useState<Step>('choose-type')
  const [shortcutKey, setShortcutKey] = useState('c')
  const [shortcutModifiers, setShortcutModifiers] = useState<TerminalShortcutModifier[]>(['ctrl'])
  const [macroLabel, setMacroLabel] = useState('')
  const [macroText, setMacroText] = useState('')
  const [macroEnter, setMacroEnter] = useState(true)
  const [previousVisible, setPreviousVisible] = useState(visible)
  const shortcutModifierOptions = [
    { id: 'ctrl', label: TERMINAL_SHORTCUT_MODIFIER_LABELS.ctrl },
    { id: 'alt', label: TERMINAL_SHORTCUT_MODIFIER_LABELS.alt, glyph: '⌥' },
    { id: 'shift', label: TERMINAL_SHORTCUT_MODIFIER_LABELS.shift }
  ] satisfies readonly { id: TerminalShortcutModifier; label: string; glyph?: string }[]
  const specialKeyGroups: { title: string; ids: string[]; columns: number }[] = [
    {
      title: t('customKeyModal.editing'),
      ids: ['escape', 'tab', 'enter', 'backspace', 'delete', 'insert', 'space'],
      columns: 4
    },
    {
      title: t('customKeyModal.navigation'),
      ids: ['arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight', 'home', 'end', 'pageUp', 'pageDown'],
      columns: 4
    },
    {
      title: t('customKeyModal.function'),
      ids: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'],
      columns: 6
    }
  ]

  // Why: reset before the opening commit so the drawer does not flash the last
  // custom-key draft; keep close state unchanged for the slide-out animation.
  if (visible !== previousVisible) {
    setPreviousVisible(visible)
    if (visible) {
      setStep('choose-type')
      setShortcutKey('c')
      setShortcutModifiers(['ctrl'])
      setMacroLabel('')
      setMacroText('')
      setMacroEnter(true)
    }
  }

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

  const previewKeyLabel = useMemo(() => {
    const special = SPECIAL_KEY_BY_ID[shortcutKey]
    if (special) {
      return special.label
    }
    return shortcutKey.length === 1 ? shortcutKey.toUpperCase() : shortcutKey
  }, [shortcutKey])

  const orderedActiveModifiers = shortcutModifierOptions.filter((modifier) =>
    shortcutModifiers.includes(modifier.id)
  )

  const toggleShortcutModifier = useCallback((modifier: TerminalShortcutModifier) => {
    setShortcutModifiers((current) =>
      current.includes(modifier)
        ? current.filter((item) => item !== modifier)
        : [...current, modifier]
    )
  }, [])

  const handleShortcutKeyInput = useCallback((value: string) => {
    if (value === '') {
      // Why: allow the field to go empty so backspace works; the Save button
      // stays disabled until a valid key is entered.
      setShortcutKey('')
      return
    }
    const next = normalizeShortcutKeyInput(value)
    if (next) {
      setShortcutKey(next)
    }
  }, [])

  const handleSpecialKeyPick = useCallback((id: string) => {
    setShortcutKey(id)
    setStep('shortcut-combo')
  }, [])

  const handleShortcutSave = useCallback(() => {
    const built = buildTerminalShortcutKey({ key: shortcutKey, modifiers: shortcutModifiers })
    if (!built) {
      return
    }
    void addKey({ label: built.label, bytes: built.bytes })
  }, [addKey, shortcutKey, shortcutModifiers])

  const handleMacroSave = useCallback(() => {
    const label = macroLabel.trim() || macroText.trim().slice(0, 12)
    const text = macroText
    if (!label || !text) {
      return
    }
    const bytes = macroEnter ? `${text}\r` : text
    void addKey({ label, bytes })
  }, [addKey, macroLabel, macroText, macroEnter])

  const showBack = step !== 'choose-type'
  const onBack = useCallback(() => {
    if (step === 'special-keys') {
      setStep('shortcut-combo')
    } else {
      setStep('choose-type')
    }
  }, [step])

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <View style={styles.header}>
        {showBack ? (
          <Pressable
            style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
            onPress={onBack}
            accessibilityLabel={t('customKeyModal.back')}
          >
            <ChevronLeft size={18} color={colors.textSecondary} />
          </Pressable>
        ) : (
          <View style={styles.backSpacer} />
        )}
        <Text style={styles.title}>
          {step === 'choose-type' && t('customKeyModal.addShortcut')}
          {step === 'shortcut-combo' && t('customKeyModal.shortcut')}
          {step === 'special-keys' && t('customKeyModal.pick')}
          {step === 'text-macro' && t('customKeyModal.text')}
        </Text>
        <View style={styles.backSpacer} />
      </View>

      {step === 'choose-type' && (
        <View style={styles.group}>
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setStep('shortcut-combo')}
          >
            <Text style={styles.rowLabel}>{t('customKeyModal.shortcut')}</Text>
            <Text style={styles.rowHint}>{t('customKeyModal.build')}</Text>
          </Pressable>
          <View style={styles.separator} />
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setStep('text-macro')}
          >
            <Text style={styles.rowLabel}>{t('customKeyModal.text')}</Text>
            <Text style={styles.rowHint}>{t('customKeyModal.send')}</Text>
          </Pressable>
          {onManageShortcuts ? (
            <>
              <View style={styles.separator} />
              <Pressable
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={onManageShortcuts}
              >
                <Text style={styles.rowLabel}>{t('customKeyModal.manage')}</Text>
                <Text style={styles.rowHint}>{t('customKeyModal.show')}</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      )}

      {step === 'shortcut-combo' && (
        <View style={styles.shortcutForm}>
          <View style={styles.preview}>
            {orderedActiveModifiers.map((modifier, index) => (
              <View key={modifier.id} style={styles.previewKeycapRow}>
                {index > 0 ? <Text style={styles.previewPlus}>+</Text> : null}
                <View style={[styles.keycap, styles.keycapModifier]}>
                  <Text style={styles.keycapModifierText}>{modifier.label}</Text>
                </View>
              </View>
            ))}
            {orderedActiveModifiers.length > 0 ? <Text style={styles.previewPlus}>+</Text> : null}
            <View style={[styles.keycap, !shortcutPreview && styles.keycapWarn]}>
              <Text style={[styles.keycapText, !shortcutPreview && styles.keycapTextWarn]}>
                {previewKeyLabel}
              </Text>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>{t('customKeyModal.modifiers')}</Text>
            <View style={styles.mods}>
              {shortcutModifierOptions.map((modifier) => {
                const selected = shortcutModifiers.includes(modifier.id)
                return (
                  <Pressable
                    key={modifier.id}
                    style={({ pressed }) => [
                      styles.chip,
                      selected && styles.chipSelected,
                      pressed && !selected && styles.chipPressed
                    ]}
                    onPress={() => toggleShortcutModifier(modifier.id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                  >
                    <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                      {modifier.label}
                    </Text>
                    {modifier.glyph ? (
                      <Text style={[styles.chipGlyph, selected && styles.chipGlyphSelected]}>
                        {modifier.glyph}
                      </Text>
                    ) : null}
                  </Pressable>
                )
              })}
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>{t('customKeyModal.key')}</Text>
            <TextInput
              style={styles.keyInput}
              value={shortcutKey.length === 1 ? shortcutKey.toUpperCase() : ''}
              onChangeText={handleShortcutKeyInput}
              placeholder={SPECIAL_KEY_BY_ID[shortcutKey]?.label ?? 'C'}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={1}
            />
            <Pressable
              style={({ pressed }) => [styles.moreLink, pressed && styles.moreLinkPressed]}
              onPress={() => setStep('special-keys')}
            >
              <Text style={styles.moreLinkText}>{t('customKeyModal.more')}</Text>
            </Pressable>
          </View>

          <Pressable
            style={[styles.saveButton, !shortcutPreview && styles.saveButtonDisabled]}
            disabled={!shortcutPreview}
            onPress={handleShortcutSave}
          >
            <Text
              style={[styles.saveButtonText, !shortcutPreview && styles.saveButtonTextDisabled]}
            >
              {t('customKeyModal.add')}
            </Text>
          </Pressable>
        </View>
      )}

      {step === 'special-keys' && (
        <View style={styles.specialKeysForm}>
          {specialKeyGroups.map((group) => (
            <View key={group.title} style={styles.specialGroup}>
              <Text style={styles.specialGroupTitle}>{group.title}</Text>
              <View style={styles.keyGrid}>
                {group.ids.map((id) => {
                  const key = SPECIAL_KEY_BY_ID[id]
                  if (!key) {
                    return null
                  }
                  const selected = shortcutKey === id
                  const flexBasis = `${100 / group.columns}%` as const
                  return (
                    <View key={id} style={[styles.keyCellWrap, { flexBasis }]}>
                      <Pressable
                        style={({ pressed }) => [
                          styles.keyCell,
                          selected && styles.keyCellSelected,
                          pressed && !selected && styles.keyCellPressed
                        ]}
                        onPress={() => handleSpecialKeyPick(id)}
                        accessibilityLabel={key.accessibilityLabel}
                        accessibilityState={{ selected }}
                      >
                        <Text style={[styles.keyCellText, selected && styles.keyCellTextSelected]}>
                          {key.label}
                        </Text>
                      </Pressable>
                    </View>
                  )
                })}
              </View>
            </View>
          ))}
        </View>
      )}

      {step === 'text-macro' && (
        <View style={styles.group}>
          <View style={styles.macroForm}>
            <Text style={styles.fieldLabel}>{t('customKeyModal.label')}</Text>
            <TextInput
              style={styles.fieldInput}
              value={macroLabel}
              onChangeText={setMacroLabel}
              placeholder={t('customKeyModal.eGBuild')}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.fieldLabel}>{t('customKeyModal.command')}</Text>
            <TextInput
              style={styles.fieldInput}
              value={macroText}
              onChangeText={setMacroText}
              placeholder={t('customKeyModal.eGPnpm')}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>{t('customKeyModal.press')}</Text>
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
              <Text
                style={[styles.saveButtonText, !macroText.trim() && styles.saveButtonTextDisabled]}
              >
                {t('customKeyModal.addShortcut')}
              </Text>
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
    paddingTop: spacing.sm
  },
  preview: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg + spacing.xs,
    flexWrap: 'wrap'
  },
  previewKeycapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  previewPlus: {
    color: colors.textMuted,
    fontSize: 16
  },
  keycap: {
    minWidth: 48,
    height: 48,
    paddingHorizontal: spacing.md,
    borderRadius: 10,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center'
  },
  keycapModifier: {
    minWidth: 0
  },
  keycapWarn: {
    borderColor: colors.statusAmber
  },
  keycapText: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 17,
    fontWeight: '600'
  },
  keycapTextWarn: {
    color: colors.statusAmber
  },
  keycapModifierText: {
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: 14,
    fontWeight: '600'
  },
  section: {
    marginTop: spacing.md
  },
  sectionLabel: {
    fontSize: 11,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.sm,
    paddingLeft: 2
  },
  mods: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  chip: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    backgroundColor: colors.bgPanel,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4
  },
  chipSelected: {
    backgroundColor: colors.textPrimary
  },
  chipPressed: {
    backgroundColor: colors.bgRaised
  },
  chipText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: '500'
  },
  chipTextSelected: {
    color: colors.bgBase
  },
  chipGlyph: {
    color: colors.textMuted,
    fontSize: 13,
    fontFamily: typography.monoFamily
  },
  chipGlyphSelected: {
    color: 'rgba(10,10,10,0.5)'
  },
  keyInput: {
    width: '100%',
    height: 56,
    borderRadius: 10,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center'
  },
  moreLink: {
    paddingVertical: spacing.sm,
    alignItems: 'center'
  },
  moreLinkPressed: {
    opacity: 0.6
  },
  moreLinkText: {
    color: colors.textSecondary,
    fontSize: 13,
    textDecorationLine: 'underline'
  },
  specialKeysForm: {
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
    gap: spacing.md
  },
  specialGroup: {
    gap: spacing.xs
  },
  specialGroupTitle: {
    fontSize: 11,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingLeft: 2,
    marginBottom: spacing.xs
  },
  keyGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -spacing.xs / 2
  },
  keyCellWrap: {
    paddingHorizontal: spacing.xs / 2,
    paddingVertical: spacing.xs / 2
  },
  keyCell: {
    height: 40,
    borderRadius: 8,
    backgroundColor: colors.bgPanel,
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
    fontSize: 13,
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
    marginTop: spacing.md,
    backgroundColor: colors.textPrimary,
    paddingVertical: spacing.md,
    borderRadius: 10,
    alignItems: 'center'
  },
  saveButtonDisabled: {
    backgroundColor: colors.bgRaised
  },
  saveButtonText: {
    color: colors.bgBase,
    fontSize: 15,
    fontWeight: '600'
  },
  saveButtonTextDisabled: {
    color: colors.textMuted
  }
})
