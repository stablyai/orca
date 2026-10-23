import { useCallback, useMemo, useState } from 'react'
import { View, Text, Pressable, TextInput } from 'react-native'
import { Command, SlidersHorizontal, Type } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { triggerError, triggerSelection, triggerSuccess } from '../platform/haptics'
import { BottomDrawer } from './BottomDrawer'
import { MobileSwitch } from './MobileSwitch'
import { Banner } from './ui/Banner'
import { Button } from './ui/Button'
import { FilterChip } from './ui/FilterChip'
import { ListGroup, LIST_LEADING_INSET } from './ui/ListGroup'
import { ListRow } from './ui/ListRow'
import { SectionHeader } from './ui/SectionHeader'
import { SheetHeader } from './ui/SheetHeader'
import { TextField } from './ui/TextField'
import { pressTransition } from './ui/transition-styles'
import {
  buildTerminalShortcutKey,
  normalizeShortcutKeyInput,
  TERMINAL_SHORTCUT_SPECIAL_KEYS,
  type TerminalShortcutModifier,
  type TerminalShortcutSpecialKey
} from '../terminal/terminal-accessory-keys'
import { customKeyModalStyles as styles } from './CustomKeyModal.styles'
import { updateStoredCustomKeys, type CustomKey } from '../terminal/terminal-custom-keys'

type Step = 'choose-type' | 'shortcut-combo' | 'special-keys' | 'text-macro'

// Why: Alt is rendered with the ⌥ glyph because on macOS hosts the Option key
// is the only modifier that produces an ESC-prefixed byte sequence terminals
// can read. Cmd is intentionally absent — macOS swallows it before keystrokes
// reach the shell, so there's nothing to encode.
const SHORTCUT_MODIFIERS: { id: TerminalShortcutModifier; label: string; glyph?: string }[] = [
  { id: 'ctrl', label: 'Ctrl' },
  { id: 'alt', label: 'Alt', glyph: '⌥' },
  { id: 'shift', label: 'Shift' }
]

// Why: special keys are grouped by purpose so the picker reads as three small
// fixed grids rather than one ragged wrap row that clipped F7-F12.
const SPECIAL_KEY_GROUPS: { title: string; ids: string[]; columns: number }[] = [
  {
    title: 'Editing',
    ids: ['escape', 'tab', 'enter', 'backspace', 'delete', 'insert', 'space'],
    columns: 4
  },
  {
    title: 'Navigation',
    ids: ['arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight', 'home', 'end', 'pageUp', 'pageDown'],
    columns: 4
  },
  {
    title: 'Function',
    ids: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'],
    columns: 6
  }
]

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
  const [step, setStep] = useState<Step>('choose-type')
  const [shortcutKey, setShortcutKey] = useState('c')
  const [shortcutModifiers, setShortcutModifiers] = useState<TerminalShortcutModifier[]>(['ctrl'])
  const [macroLabel, setMacroLabel] = useState('')
  const [macroText, setMacroText] = useState('')
  const [macroEnter, setMacroEnter] = useState(true)
  const [previousVisible, setPreviousVisible] = useState(visible)
  const [saveError, setSaveError] = useState(false)
  const [keyFocused, setKeyFocused] = useState(false)

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
      setSaveError(false)
    }
  }

  const addKey = useCallback(
    async (key: Omit<CustomKey, 'id'>) => {
      setSaveError(false)
      const newKey: CustomKey = { ...key, id: `custom-${Date.now()}` }
      let updated: CustomKey[]
      // Caught here because both callers are `void addKey(...)`, which leaves a rejection nowhere
      // to go. On the page this key is allowlisted and its write rejects for size — the contract
      // `page-async-storage` states, and the one ruling 33.6 extends to a key `init` could not
      // carry at all — so an uncaught save here reaches the document's unhandled-rejection
      // handler, which reports a page fault and drops the generation for a key nobody could add.
      // Every other allowlisted writer in this closure already catches its own save.
      try {
        updated = await updateStoredCustomKeys((keys) => [...keys, newKey])
      } catch (error) {
        // Not closed: a drawer that dismissed itself and announced the key would put a row on the
        // accessory bar that no store holds and the next load would not have.
        console.warn('[custom-keys] the store would not take this key', error)
        triggerError()
        setSaveError(true)
        return
      }
      triggerSuccess()
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
    setSaveError(false)
    if (step === 'special-keys') {
      setStep('shortcut-combo')
    } else {
      setStep('choose-type')
    }
  }, [step])

  const goTo = (next: Step) => {
    setSaveError(false)
    setStep(next)
  }
  const saveErrorBanner = saveError ? (
    <Banner
      tone="error"
      title="Couldn't save this shortcut"
      message="This phone's storage refused it. A shorter command may fit."
    />
  ) : null

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <View style={styles.header}>
        <SheetHeader
          title={
            step === 'choose-type'
              ? 'Add shortcut'
              : step === 'shortcut-combo'
                ? 'Key combo'
                : step === 'special-keys'
                  ? 'Pick a key'
                  : 'Text macro'
          }
          leading={showBack ? { label: 'Back', onPress: onBack } : undefined}
          onClose={showBack ? undefined : onClose}
        />
      </View>

      {step === 'choose-type' && (
        <ListGroup separatorInset={LIST_LEADING_INSET} style={styles.group}>
          <ListRow
            title="Key combo"
            subtitle="Ctrl, Alt and Shift chords"
            leading={<Command size={20} color={colors.textSecondary} strokeWidth={2} />}
            navigates
            onPress={() => goTo('shortcut-combo')}
          />
          <ListRow
            title="Text macro"
            subtitle="Type a saved command"
            leading={<Type size={20} color={colors.textSecondary} strokeWidth={2} />}
            navigates
            onPress={() => goTo('text-macro')}
          />
          {onManageShortcuts ? (
            <ListRow
              title="Manage shortcuts"
              subtitle="Show, hide or reorder keys"
              leading={<SlidersHorizontal size={20} color={colors.textSecondary} strokeWidth={2} />}
              navigates
              onPress={onManageShortcuts}
            />
          ) : null}
        </ListGroup>
      )}

      {step === 'shortcut-combo' && (
        <View style={styles.form}>
          <View
            style={styles.preview}
            accessibilityRole="text"
            accessibilityLabel={
              shortcutPreview ? `Preview, ${shortcutPreview.label}` : 'Not a valid combination yet'
            }
          >
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

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Modifiers</Text>
            <View style={styles.mods}>
              {SHORTCUT_MODIFIERS.map((modifier) => (
                <FilterChip
                  key={modifier.id}
                  label={modifier.glyph ? `${modifier.label} ${modifier.glyph}` : modifier.label}
                  accessibilityLabel={modifier.label}
                  active={shortcutModifiers.includes(modifier.id)}
                  onPress={() => {
                    triggerSelection()
                    toggleShortcutModifier(modifier.id)
                  }}
                />
              ))}
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Key</Text>
            <TextInput
              style={[styles.keyInput, keyFocused && styles.keyInputFocused]}
              value={shortcutKey.length === 1 ? shortcutKey.toUpperCase() : ''}
              onChangeText={handleShortcutKeyInput}
              onFocus={() => setKeyFocused(true)}
              onBlur={() => setKeyFocused(false)}
              placeholder={SPECIAL_KEY_BY_ID[shortcutKey]?.label ?? 'C'}
              placeholderTextColor={colors.textMuted}
              selectionColor={colors.accentBlue}
              accessibilityLabel="Key"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={1}
            />
          </View>
          <ListGroup style={styles.groupFlush}>
            <ListRow
              title="More keys"
              subtitle="Tab, arrows, F1–F12 and more"
              navigates
              onPress={() => goTo('special-keys')}
            />
          </ListGroup>

          {saveErrorBanner}
          <Button
            label="Add shortcut"
            variant="primary"
            block
            disabled={!shortcutPreview}
            onPress={handleShortcutSave}
          />
        </View>
      )}

      {step === 'special-keys' && (
        <View style={styles.specialKeysForm}>
          {SPECIAL_KEY_GROUPS.map((group, groupIndex) => (
            <View key={group.title}>
              <SectionHeader title={group.title} first={groupIndex === 0} />
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
                        onPress={() => {
                          triggerSelection()
                          handleSpecialKeyPick(id)
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={key.accessibilityLabel}
                        accessibilityState={{ selected }}
                      >
                        {({ pressed }) => (
                          <View
                            style={[
                              styles.keyCell,
                              selected && styles.keyCellSelected,
                              pressed && styles.keyCellPressed,
                              pressed ? pressTransition.pressed : pressTransition.rest
                            ]}
                          >
                            <Text style={styles.keyCellText}>{key.label}</Text>
                          </View>
                        )}
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
        <View style={styles.form}>
          <TextField
            label="Name"
            value={macroLabel}
            onChangeText={setMacroLabel}
            placeholder="Build"
            footnote="Shown on the key. Leave it empty to use the command."
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextField
            label="Command"
            value={macroText}
            onChangeText={setMacroText}
            placeholder="pnpm build"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <ListGroup style={styles.groupFlush}>
            <ListRow
              title="Press Enter"
              subtitle="Run it straight away instead of only typing it."
              subtitleNumberOfLines={2}
              accessory={
                <MobileSwitch
                  value={macroEnter}
                  onValueChange={(next) => {
                    triggerSelection()
                    setMacroEnter(next)
                  }}
                  accessibilityLabel="Press Enter after the command"
                />
              }
            />
          </ListGroup>
          {saveErrorBanner}
          <Button
            label="Add shortcut"
            variant="primary"
            block
            disabled={!macroText.trim()}
            onPress={handleMacroSave}
          />
        </View>
      )}
    </BottomDrawer>
  )
}
