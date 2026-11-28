import { useCallback, useMemo, useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import { TextField } from '../../../components/composer-input/TextField'
import { FieldTextInput } from '../../../components/composer-input/FieldTextInput'
import { MobileSegmentedControl } from '../../../components/controls/MobileSegmentedControl'
import { MobileSwitch } from '../../../components/controls/MobileSwitch'
import { ListGroup, ListRow, SectionHeader } from '../../../components/list/ListGroup'
import { SheetHeader } from '../../../components/nav-bar/SheetHeader'
import {
  buildTerminalShortcutKey,
  normalizeShortcutKeyInput,
  type TerminalShortcutModifier,
  type TerminalShortcutSpecialKey
} from '../../key-input/terminal-accessory-keys'
import {
  TERMINAL_SHORTCUT_SPECIAL_KEY_DEFINITIONS as TERMINAL_SHORTCUT_SPECIAL_KEYS,
  terminalSpecialKeyAccessibilityLabel
} from '../../key-input/terminal-key-definitions'
import { customKeyModalStylesSheet } from './CustomKeyModal.styles'
import { updateStoredCustomKeys, type CustomKey } from '../../key-input/terminal-custom-keys'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useThemedStyles } from '../../../theme/themed-styles'

type Kind = 'combo' | 'text'

// Alt/Option sends the ESC prefix a terminal reads; Cmd is absent because macOS takes it before the shell.
const SHORTCUT_MODIFIERS: { id: TerminalShortcutModifier; label: string }[] = [
  { id: 'ctrl', label: 'Ctrl' },
  { id: 'alt', label: 'Alt' },
  { id: 'shift', label: 'Shift' }
]

// Fixed grids per group; ragged wrapping clipped F7–F12.
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

function keyLabel(key: string): string {
  return SPECIAL_KEY_BY_ID[key]?.label ?? key.toUpperCase()
}

type Props = {
  visible: boolean
  onClose: () => void
  onKeysChanged: (keys: CustomKey[]) => void
}

// Add a key to the terminal's row: a key combo built from switches, or text to type.
export function CustomKeyModal({ visible, onClose, onKeysChanged }: Props) {
  const styles = useThemedStyles(customKeyModalStylesSheet)
  const t = useMobileTranslation()
  const [kind, setKind] = useState<Kind>('combo')
  const [pickingKey, setPickingKey] = useState(false)
  const [shortcutKey, setShortcutKey] = useState('c')
  const [shortcutModifiers, setShortcutModifiers] = useState<TerminalShortcutModifier[]>(['ctrl'])
  const [macroLabel, setMacroLabel] = useState('')
  const [macroText, setMacroText] = useState('')
  const [macroEnter, setMacroEnter] = useState(true)
  const [previousVisible, setPreviousVisible] = useState(visible)

  // Reset the draft as it opens, not as it closes, so the slide-out keeps what it showed.
  if (visible !== previousVisible) {
    setPreviousVisible(visible)
    if (visible) {
      setKind('combo')
      setPickingKey(false)
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
      // Page storage can refuse a write (size, unseeded key); keep the sheet open rather than claim it saved.
      try {
        updated = await updateStoredCustomKeys((keys) => [...keys, newKey])
      } catch (error) {
        console.warn('[custom-keys] the store would not take this key', error)
        return
      }
      onKeysChanged(updated)
      onClose()
    },
    [onClose, onKeysChanged]
  )

  const shortcut = useMemo(
    () => buildTerminalShortcutKey({ key: shortcutKey, modifiers: shortcutModifiers }),
    [shortcutKey, shortcutModifiers]
  )
  const macroName = macroLabel.trim() || macroText.trim().slice(0, 12)
  const canAdd = kind === 'combo' ? shortcut !== null : macroText.trim().length > 0

  const add = () => {
    if (kind === 'combo') {
      if (shortcut) {
        void addKey({ label: shortcut.label, bytes: shortcut.bytes, enter: false })
      }
      return
    }
    if (macroName && macroText) {
      void addKey({
        label: macroName,
        bytes: macroEnter ? `${macroText}\r` : macroText,
        enter: false
      })
    }
  }

  const toggleModifier = (modifier: TerminalShortcutModifier, on: boolean) =>
    setShortcutModifiers((current) =>
      on ? [...current, modifier] : current.filter((item) => item !== modifier)
    )

  const pickKey = (key: string) => {
    setShortcutKey(key)
    setPickingKey(false)
  }

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      {pickingKey ? (
        <>
          <SheetHeader
            title={t('components.customKeyModal.key', 'Key')}
            onBack={{ label: t('common.back', 'Back'), onPress: () => setPickingKey(false) }}
          />
          <SectionHeader
            title={t('components.customKeyModal.letterOrSymbol', 'Letter, number or symbol')}
            first
          />
          <FieldTextInput
            style={styles.keyInput}
            // Empty, with the current key as its placeholder, so any typed character picks a new one.
            value=""
            onChangeText={(value) => {
              const next = normalizeShortcutKeyInput(value)
              if (next) {
                pickKey(next)
              }
            }}
            placeholder={shortcutKey.length === 1 ? keyLabel(shortcutKey) : 'C'}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
            maxLength={1}
          />
          {specialKeyGroups(t).map((group) => (
            <View key={group.id}>
              <SectionHeader title={group.title} />
              <View style={styles.keyGrid}>
                {group.ids.map((id) => {
                  const key = SPECIAL_KEY_BY_ID[id]
                  if (!key) {
                    return null
                  }
                  const selected = shortcutKey === id
                  return (
                    <View
                      key={id}
                      style={[styles.keyCellWrap, { flexBasis: `${100 / group.columns}%` }]}
                    >
                      <Pressable
                        style={({ pressed }) => [
                          styles.keyCell,
                          selected && styles.keyCellSelected,
                          pressed && !selected && styles.keyCellPressed
                        ]}
                        onPress={() => pickKey(id)}
                        accessibilityRole="button"
                        accessibilityLabel={terminalSpecialKeyAccessibilityLabel(id, t)}
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
          <View style={styles.bottomSpace} />
        </>
      ) : (
        <>
          <SheetHeader
            title={t('components.customKeyModal.title', 'Add a key')}
            // What the new key will read, kept as a line even when empty so switching kinds doesn't move the title.
            subtitle={kind === 'combo' ? (shortcut?.label ?? '') : macroName}
            leading={{ label: t('common.cancel', 'Cancel'), onPress: onClose }}
            trailing={{
              label: t('components.customKeyModal.add', 'Add'),
              onPress: add,
              disabled: !canAdd
            }}
          />
          <MobileSegmentedControl
            segments={[
              { value: 'combo', label: t('components.customKeyModal.keyCombo', 'Key combo') },
              { value: 'text', label: t('components.customKeyModal.text', 'Text') }
            ]}
            selected={kind}
            onSelect={setKind}
            fill
            onSheet
            style={styles.kinds}
          />
          {kind === 'combo' ? (
            <ListGroup>
              {[
                ...SHORTCUT_MODIFIERS.map((modifier) => (
                  <ListRow
                    key={modifier.id}
                    title={modifier.label}
                    accessory={
                      <MobileSwitch
                        accessibilityLabel={modifier.label}
                        value={shortcutModifiers.includes(modifier.id)}
                        onValueChange={(on) => toggleModifier(modifier.id, on)}
                      />
                    }
                  />
                )),
                <ListRow
                  key="key"
                  title={t('components.customKeyModal.key', 'Key')}
                  value={shortcutKey ? keyLabel(shortcutKey) : undefined}
                  navigates
                  onPress={() => setPickingKey(true)}
                />
              ]}
            </ListGroup>
          ) : (
            <>
              <SectionHeader title={t('components.customKeyModal.text', 'Text')} first />
              <TextField
                monospace
                value={macroText}
                onChangeText={setMacroText}
                placeholder={t('components.customKeyModal.commandPlaceholder', 'e.g. pnpm build')}
                accessibilityLabel={t('components.customKeyModal.text', 'Text')}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <SectionHeader title={t('components.customKeyModal.name', 'Name on the key')} />
              <TextField
                value={macroLabel}
                onChangeText={setMacroLabel}
                placeholder={
                  macroText.trim().slice(0, 12) ||
                  t('components.customKeyModal.labelPlaceholder', 'e.g. Build')
                }
                accessibilityLabel={t('components.customKeyModal.name', 'Name on the key')}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <ListGroup style={styles.enterGroup}>
                <ListRow
                  title={t('components.customKeyModal.pressEnter', 'Press Enter')}
                  accessory={
                    <MobileSwitch
                      accessibilityLabel={t('components.customKeyModal.pressEnter', 'Press Enter')}
                      value={macroEnter}
                      onValueChange={setMacroEnter}
                    />
                  }
                />
              </ListGroup>
            </>
          )}
          <View style={styles.bottomSpace} />
        </>
      )}
    </BottomDrawer>
  )
}
