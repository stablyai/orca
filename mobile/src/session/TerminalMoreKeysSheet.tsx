import { useRef } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ClipboardPaste, FileUp, ImagePlus, Monitor, Plus, Smartphone } from 'lucide-react-native'
import type { LucideIcon } from 'lucide-react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { triggerMediumImpact } from '../platform/haptics'
import type { TerminalAccessoryKey } from '../terminal/terminal-accessory-keys'
import { TERMINAL_SHORTCUT_SPECIAL_KEYS } from '../terminal/terminal-accessory-keys'
import type { CustomKey } from '../terminal/terminal-custom-keys'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
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

// Everything that does not fit on the key row: clipboard, attachments, the rest of the keys and the user's own keys.
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
  const combos = sheetKeys.filter((key) => key.id.startsWith('ctrl'))
  const keys = sheetKeys.filter((key) => !key.id.startsWith('ctrl'))

  const action = (label: string, Icon: LucideIcon, onPress: () => void, enabled = canSend) => (
    <Pressable
      key={label}
      style={({ pressed }) => [
        styles.sheetAction,
        pressed && styles.keyPressed,
        !enabled && styles.disabled
      ]}
      disabled={!enabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon size={16} color={colors.textSecondary} strokeWidth={2.2} />
      <Text style={styles.sheetActionText}>{label}</Text>
    </Pressable>
  )

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
      <View style={styles.sheetContent}>
        <View style={styles.sheetActions}>
          {canPaste
            ? action(t('session.terminalMoreKeys.paste', 'Paste'), ClipboardPaste, () =>
                closeThen(onPaste)
              )
            : null}
          {action(
            isAttaching
              ? t('session.terminalMoreKeys.sending', 'Sending…')
              : t('session.terminalMoreKeys.photo', 'Photo'),
            ImagePlus,
            () => closeThen(onAttachImage),
            canSend && !isAttaching
          )}
          {action(
            t('session.terminalMoreKeys.file', 'File'),
            FileUp,
            () => closeThen(onAttachFile),
            canSend && !isAttaching
          )}
          {action(
            phoneDisplay
              ? t('session.terminalMoreKeys.desktopWidth', 'Desktop width')
              : t('session.terminalMoreKeys.phoneWidth', 'Phone width'),
            phoneDisplay ? Monitor : Smartphone,
            () => closeThen(onToggleDisplay)
          )}
        </View>
        <Text style={styles.sheetHeading}>{t('session.terminalMoreKeys.keys', 'Keys')}</Text>
        <View style={styles.sheetGrid}>
          {keys.map((k) =>
            key(k.id, k.label, k.accessibilityLabel ?? k.label, () => onBuiltInKey(k))
          )}
          {EXTRA_KEYS.map((k) =>
            key(k.id, k.label, k.accessibilityLabel, () => onSpecialKey(k.id))
          )}
        </View>
        {combos.length > 0 ? (
          <>
            <Text style={styles.sheetHeading}>
              {t('session.terminalMoreKeys.combos', 'Combos')}
            </Text>
            <View style={styles.sheetGrid}>
              {combos.map((k) =>
                key(k.id, k.label, k.accessibilityLabel ?? k.label, () => onBuiltInKey(k))
              )}
            </View>
          </>
        ) : null}
        <Text style={styles.sheetHeading}>
          {t('session.terminalMoreKeys.yourKeys', 'Your keys')}
        </Text>
        <View style={styles.sheetGrid}>
          {customKeys.map((custom) => (
            <Pressable
              key={custom.id}
              style={({ pressed }) => [
                styles.key,
                styles.sheetKey,
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
              <Text style={styles.keyText}>{custom.label}</Text>
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
              {t('session.terminalMoreKeys.addKey', 'Add key')}
            </Text>
          </Pressable>
        </View>
      </View>
    </BottomDrawer>
  )
}
