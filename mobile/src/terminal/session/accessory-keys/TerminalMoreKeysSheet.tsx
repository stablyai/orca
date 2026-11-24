import { useRef } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ClipboardPaste, Image, Monitor, Paperclip, Plus } from 'lucide-react-native'
import type { LucideIcon } from 'lucide-react-native'
import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import {
  LIST_LEADING_INSET,
  ListGroup,
  ListRow,
  SectionHeader
} from '../../../components/list/ListGroup'
import { SheetHeader } from '../../../components/nav-bar/SheetHeader'
import { MobileSwitch } from '../../../components/controls/MobileSwitch'
import { triggerMediumImpact } from '../../../platform/haptics/haptics'
import type { TerminalAccessoryKey } from '../../key-input/terminal-accessory-keys'
import '../../key-input/terminal-accessory-keys'
import { TERMINAL_SHORTCUT_SPECIAL_KEY_DEFINITIONS as TERMINAL_SHORTCUT_SPECIAL_KEYS } from '../../key-input/terminal-key-definitions'
import type { CustomKey } from '../../key-input/terminal-custom-keys'
import type { Translate } from '../../../i18n/mobile-i18n'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { terminalDockStyles as styles } from './terminal-dock-styles'

const EXTRA_KEY_IDS = new Set([
  'home',
  'end',
  'pageUp',
  'pageDown',
  'insert',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12'
])
const EXTRA_KEYS = TERMINAL_SHORTCUT_SPECIAL_KEYS.filter((key) => EXTRA_KEY_IDS.has(key.id))

// What a Ctrl combo does, so the sheet names it rather than spelling the chord.
function shortcutName(t: Translate, id: string): string | null {
  switch (id) {
    case 'ctrlC':
      return t('session.terminalMoreKeys.interrupt', 'Interrupt')
    case 'ctrlD':
      return t('session.terminalMoreKeys.endOfInput', 'End of input')
    case 'ctrlL':
      return t('session.terminalMoreKeys.clearScreen', 'Clear screen')
    case 'ctrlZ':
      return t('session.terminalMoreKeys.suspend', 'Suspend')
    case 'ctrlR':
      return t('session.terminalMoreKeys.searchHistory', 'Search history')
    case 'ctrlA':
      return t('session.terminalMoreKeys.lineStart', 'Start of line')
    case 'ctrlE':
      return t('session.terminalMoreKeys.lineEnd', 'End of line')
    case 'ctrlW':
      return t('session.terminalMoreKeys.deleteWord', 'Delete word')
    case 'ctrlU':
      return t('session.terminalMoreKeys.deleteLine', 'Delete to line start')
    default:
      return null
  }
}

type TerminalMoreKeysSheetProps = {
  /** Keys the current row already shows, which the sheet leaves out. */
  readonly rowKeyIds: ReadonlySet<string>
  readonly visible: boolean
  readonly onClose: () => void
  readonly canSend: boolean
  readonly canPaste: boolean
  readonly isAttaching: boolean
  readonly phoneDisplay: boolean
  readonly builtInKeys: readonly TerminalAccessoryKey[]
  readonly customKeys: readonly CustomKey[]
  readonly onPaste: () => void
  readonly onAttachImage: () => void
  readonly onAttachFile: () => void
  readonly onToggleDisplay: () => void
  readonly onBuiltInKey: (key: TerminalAccessoryKey) => void
  readonly onSpecialKey: (id: string) => void
  readonly onCustomKey: (key: CustomKey) => void
  readonly onDeleteCustomKey: (key: CustomKey) => void
  readonly onAddCustomKey: () => void
}

// Everything the key row leaves out: clipboard, attachments, desktop width, named shortcuts, the rest of the keys and the user's own.
export function TerminalMoreKeysSheet({
  visible,
  onClose,
  canSend,
  canPaste,
  isAttaching,
  phoneDisplay,
  rowKeyIds,
  builtInKeys,
  customKeys,
  onPaste,
  onAttachImage,
  onAttachFile,
  onToggleDisplay,
  onBuiltInKey,
  onSpecialKey,
  onCustomKey,
  onDeleteCustomKey,
  onAddCustomKey
}: TerminalMoreKeysSheetProps): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Pickers and modals open after the sheet is gone so they never stack under it.
  const afterCloseRef = useRef<(() => void) | null>(null)
  const closeThen = (action: () => void) => {
    afterCloseRef.current = action
    onClose()
  }
  const sheetKeys = builtInKeys.filter((key) => !rowKeyIds.has(key.id))
  const shortcuts = sheetKeys.flatMap((key) => {
    const name = shortcutName(t, key.id)
    return name === null ? [] : [{ key, name }]
  })
  const keys = sheetKeys.filter((key) => shortcutName(t, key.id) === null)

  const icon = (Icon: LucideIcon) => <Icon size={16} color={colors.textSecondary} />

  const key = (id: string, label: string, accessibilityLabel: string, onPress: () => void) => (
    <Pressable
      key={id}
      style={({ pressed }) => [
        styles.key,
        styles.sheetKey,
        pressed && styles.keyPressed,
        !canSend && styles.disabled
      ]}
      disabled={!canSend}
      onPress={() => {
        onPress()
        onClose()
      }}
      accessibilityRole="button"
      accessibilityLabel={t('session.terminalMoreKeys.sendKey', 'Send {{label}}', {
        label: accessibilityLabel
      })}
    >
      <Text style={styles.keyText}>{label}</Text>
    </Pressable>
  )

  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      onAfterClose={() => {
        const run = afterCloseRef.current
        afterCloseRef.current = null
        run?.()
      }}
      dragContentToDismiss
    >
      <SheetHeader title={t('session.terminalMoreKeys.title', 'More keys')} />
      <View style={styles.sheetContent}>
        <ListGroup separatorInset={LIST_LEADING_INSET}>
          {canPaste ? (
            <ListRow
              key="paste"
              title={t('session.terminalMoreKeys.paste', 'Paste')}
              leading={icon(ClipboardPaste)}
              disabled={!canSend}
              onPress={() => closeThen(onPaste)}
            />
          ) : null}
          <ListRow
            key="photo"
            title={
              isAttaching
                ? t('session.terminalLiveInputStatus.uploading', 'Uploading…')
                : t('session.terminalMoreKeys.photo', 'Photo')
            }
            leading={icon(Image)}
            disabled={!canSend || isAttaching}
            onPress={() => closeThen(onAttachImage)}
          />
          <ListRow
            key="file"
            title={t('session.terminalMoreKeys.file', 'File')}
            leading={icon(Paperclip)}
            disabled={!canSend || isAttaching}
            onPress={() => closeThen(onAttachFile)}
          />
          <ListRow
            key="width"
            title={t('session.terminalMoreKeys.desktopWidth', 'Desktop width')}
            leading={icon(Monitor)}
            disabled={!canSend}
            accessory={
              <MobileSwitch
                accessibilityLabel={t('session.terminalMoreKeys.desktopWidth', 'Desktop width')}
                value={!phoneDisplay}
                disabled={!canSend}
                onValueChange={onToggleDisplay}
              />
            }
          />
        </ListGroup>
        {shortcuts.length > 0 ? (
          <View>
            <SectionHeader title={t('session.terminalMoreKeys.shortcuts', 'Shortcuts')} />
            <ListGroup>
              {shortcuts.map(({ key: shortcut, name }) => (
                <ListRow
                  key={shortcut.id}
                  title={name}
                  value={shortcut.label.replace('Ctrl+', '⌃')}
                  disabled={!canSend}
                  onPress={() => {
                    onBuiltInKey(shortcut)
                    onClose()
                  }}
                />
              ))}
            </ListGroup>
          </View>
        ) : null}
        <View>
          <SectionHeader title={t('session.terminalMoreKeys.keys', 'Keys')} />
          <View style={styles.sheetGrid}>
            {keys.map((k) =>
              key(k.id, k.label, k.accessibilityLabel ?? k.label, () => onBuiltInKey(k))
            )}
            {EXTRA_KEYS.map((k) =>
              key(k.id, k.label, k.accessibilityLabel, () => onSpecialKey(k.id))
            )}
          </View>
        </View>
        <View>
          <SectionHeader title={t('session.terminalMoreKeys.yourKeys', 'Your keys')} />
          <View style={styles.sheetGrid}>
            {customKeys.map((custom) => (
              <Pressable
                key={custom.id}
                style={({ pressed }) => [
                  styles.key,
                  styles.sheetKey,
                  styles.customKey,
                  pressed && styles.keyPressed,
                  !canSend && styles.disabled
                ]}
                disabled={!canSend}
                onPress={() => {
                  onCustomKey(custom)
                  onClose()
                }}
                onLongPress={() => {
                  triggerMediumImpact()
                  closeThen(() => onDeleteCustomKey(custom))
                }}
                delayLongPress={400}
                accessibilityRole="button"
                accessibilityLabel={t('session.terminalMoreKeys.sendKey', 'Send {{label}}', {
                  label: custom.label
                })}
                accessibilityHint={t(
                  'session.terminalMoreKeys.deleteKeyHint',
                  'Long press to delete this key'
                )}
              >
                <Text style={styles.keyText} numberOfLines={1}>
                  {custom.label}
                </Text>
              </Pressable>
            ))}
            <Pressable
              style={({ pressed }) => [styles.ghostKey, pressed && styles.keyPressed]}
              onPress={() => closeThen(onAddCustomKey)}
              accessibilityRole="button"
              accessibilityLabel={t('session.terminalMoreKeys.addCustomKey', 'Add custom key')}
            >
              <Plus size={14} color={colors.textSecondary} strokeWidth={2.2} />
              <Text style={[styles.keyText, styles.ghostKeyText]}>
                {t('session.terminalMoreKeys.add', 'Add')}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </BottomDrawer>
  )
}
