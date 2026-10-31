import { useCallback, useMemo, useState } from 'react'
import { View, Text, Pressable, TextInput } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { BottomDrawer } from './BottomDrawer'
import { TextField } from './composer-input/TextField'
import {
  buildTerminalShortcutKey,
  normalizeShortcutKeyInput,
  TERMINAL_SHORTCUT_SPECIAL_KEYS,
  type TerminalShortcutModifier,
  type TerminalShortcutSpecialKey
} from '../terminal/terminal-accessory-keys'
import { customKeyModalStyles as styles } from './CustomKeyModal.styles'
import { updateStoredCustomKeys, type CustomKey } from '../terminal/terminal-custom-keys'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileSwitch } from './MobileSwitch'

type Step = 'choose-type' | 'shortcut-combo' | 'special-keys' | 'text-macro'

// Alt/Option emits terminal-readable ESC prefix; Cmd is absent because macOS swallows it before shell. Render Alt as ⌥.
const SHORTCUT_MODIFIERS: { id: TerminalShortcutModifier; label: string; glyph?: string }[] = [
  { id: 'ctrl', label: 'Ctrl' },
  { id: 'alt', label: 'Alt', glyph: '⌥' },
  { id: 'shift', label: 'Shift' }
]

// Group keys into three fixed grids; ragged wrapping clipped F7–F12.
function specialKeyGroups(t: Translate) {
  return [
    {
      id: 'editing',
      title: t('components.customKeyModal.editing', 'Editing'),
      ids: ['escape', 'tab', 'enter', 'backspace', 'delete', 'insert', 'space'],
      columns: 4
    },
    {
      id: 'navigation',
      title: t('components.customKeyModal.navigation', 'Navigation'),
      ids: ['arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight', 'home', 'end', 'pageUp', 'pageDown'],
      columns: 4
    },
    {
      id: 'function',
      title: t('components.customKeyModal.function', 'Function'),
      ids: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'],
      columns: 6
    }
  ]
}

const SPECIAL_KEY_BY_ID: Record<string, TerminalShortcutSpecialKey> = Object.fromEntries(
  TERMINAL_SHORTCUT_SPECIAL_KEYS.map((key) => [key.id, key])
)

type Props = {
  visible: boolean
  onClose: () => void
  onKeysChanged: (keys: CustomKey[]) => void
  onManageShortcuts?: () => void
}

export function CustomKeyModal({ visible, onClose, onKeysChanged, onManageShortcuts }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [step, setStep] = useState<Step>('choose-type')
  const [shortcutKey, setShortcutKey] = useState('c')
  const [shortcutModifiers, setShortcutModifiers] = useState<TerminalShortcutModifier[]>(['ctrl'])
  const [macroLabel, setMacroLabel] = useState('')
  const [macroText, setMacroText] = useState('')
  const [macroEnter, setMacroEnter] = useState(true)
  const [previousVisible, setPreviousVisible] = useState(visible)

  // Reset draft before opening commit to avoid old-key flash; retain close state through slide-out.
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
      const newKey: CustomKey = { ...key, id: `custom-${Date.now()}` }
      let updated: CustomKey[]
      // Catch both void addKey callers: page storage can refuse size/unseeded-key writes (ruling 33.6), and uncaught rejection would fault/drop generation.
      // Other allowlisted writers in this closure already catch saves.
      try {
        updated = await updateStoredCustomKeys((keys) => [...keys, newKey])
      } catch (error) {
        // Keep failed-save drawer open without announcing success; otherwise accessory row would lack persisted key.
        console.warn('[custom-keys] the store would not take this key', error)
        return
      }
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

  const orderedActiveModifiers = useMemo(
    () => SHORTCUT_MODIFIERS.filter((m) => shortcutModifiers.includes(m.id)),
    [shortcutModifiers]
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
      // Allow empty field for backspace; Save still requires valid key.
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
    void addKey({ label: built.label, bytes: built.bytes, enter: false })
  }, [addKey, shortcutKey, shortcutModifiers])

  const handleMacroSave = useCallback(() => {
    const label = macroLabel.trim() || macroText.trim().slice(0, 12)
    const text = macroText
    if (!label || !text) {
      return
    }
    const bytes = macroEnter ? `${text}\r` : text
    void addKey({ label, bytes, enter: false })
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
            accessibilityRole="button"
            accessibilityLabel={t('common.back', 'Back')}
          >
            <ChevronLeft size={18} color={colors.textSecondary} />
          </Pressable>
        ) : (
          <View style={styles.backSpacer} />
        )}
        <Text style={styles.title}>
          {step === 'choose-type' && t('components.customKeyModal.addShortcut', 'Add Shortcut')}
          {step === 'shortcut-combo' &&
            t('components.customKeyModal.shortcutCombo', 'Shortcut Combo')}
          {step === 'special-keys' && t('components.customKeyModal.pickKey', 'Pick a key')}
          {step === 'text-macro' && t('components.customKeyModal.textMacro', 'Text Macro')}
        </Text>
        <View style={styles.backSpacer} />
      </View>

      {step === 'choose-type' && (
        <View style={styles.group}>
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setStep('shortcut-combo')}
          >
            <Text style={styles.rowLabel}>
              {t('components.customKeyModal.shortcutCombo', 'Shortcut Combo')}
            </Text>
            <Text style={styles.rowHint}>
              {t(
                'components.customKeyModal.shortcutComboHint',
                'Build Ctrl, Alt, and Shift key chords'
              )}
            </Text>
          </Pressable>
          <View style={styles.separator} />
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setStep('text-macro')}
          >
            <Text style={styles.rowLabel}>
              {t('components.customKeyModal.textMacro', 'Text Macro')}
            </Text>
            <Text style={styles.rowHint}>
              {t('components.customKeyModal.textMacroHint', 'Send custom text command')}
            </Text>
          </Pressable>
          {onManageShortcuts ? (
            <>
              <View style={styles.separator} />
              <Pressable
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={onManageShortcuts}
              >
                <Text style={styles.rowLabel}>
                  {t('components.customKeyModal.manageShortcuts', 'Manage Shortcuts')}
                </Text>
                <Text style={styles.rowHint}>
                  {t(
                    'components.customKeyModal.manageShortcutsHint',
                    'Show, hide, or reorder shortcut keys'
                  )}
                </Text>
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
            <Text style={styles.sectionLabel}>
              {t('components.customKeyModal.modifiers', 'Modifiers')}
            </Text>
            <View style={styles.mods}>
              {SHORTCUT_MODIFIERS.map((modifier) => {
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
            <Text style={styles.sectionLabel}>{t('components.customKeyModal.key', 'Key')}</Text>
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
              <Text style={styles.moreLinkText}>
                {t('components.customKeyModal.moreKeys', 'More keys — Tab, arrows, F1–F12…')}
              </Text>
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
              {t('components.customKeyModal.add', 'Add')}
            </Text>
          </Pressable>
        </View>
      )}

      {step === 'special-keys' && (
        <View style={styles.specialKeysForm}>
          {specialKeyGroups(t).map((group) => (
            <View key={group.id} style={styles.specialGroup}>
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
            <Text style={styles.fieldLabel}>{t('components.customKeyModal.label', 'Label')}</Text>
            <TextField
              value={macroLabel}
              onChangeText={setMacroLabel}
              placeholder={t('components.customKeyModal.labelPlaceholder', 'e.g. Build')}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.fieldLabel}>
              {t('components.customKeyModal.command', 'Command')}
            </Text>
            <TextField
              monospace
              value={macroText}
              onChangeText={setMacroText}
              placeholder={t('components.customKeyModal.commandPlaceholder', 'e.g. pnpm build')}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>
                {t('components.customKeyModal.pressEnter', 'Press Enter')}
              </Text>
              <MobileSwitch
                accessibilityLabel={t('components.customKeyModal.pressEnter', 'Press Enter')}
                value={macroEnter}
                onValueChange={setMacroEnter}
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
                {t('components.customKeyModal.addShortcut', 'Add Shortcut')}
              </Text>
            </Pressable>
          </View>
        </View>
      )}
    </BottomDrawer>
  )
}
