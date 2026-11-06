import { useEffect, useMemo, useRef } from 'react'
import { View, Text, ScrollView, Pressable } from 'react-native'
import {
  ChevronDown,
  Keyboard as KeyboardIcon,
  Monitor,
  Plus,
  Smartphone
} from 'lucide-react-native'
import { triggerMediumImpact } from '../platform/haptics'
import { createTerminalLiveAccessoryInput } from '../terminal/terminal-live-accessory-input'
import { TERMINAL_ACCESSORY_REPEAT_DELAY_MS } from '../terminal/terminal-accessory-repeat'
import { getVisibleTerminalAccessoryKeys } from '../terminal/terminal-accessory-layout'
import { useDirectionPadAvailable } from '../layout/use-shell-side-rail'
import { isTerminalPhoneDisplayMode } from './mobile-session-route-helpers'
import { TERMINAL_KEY_HIT_SLOP, terminalDockStyles as styles } from './terminal-dock-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { styles as sessionStyles } from './mobile-session-styles'
import { useKeyboardPersistingTaps } from '../platform/keyboard-persisting-taps'
import type { MobileSessionController } from './use-mobile-session-controller'

// The terminal's key row above the live input; every key goes straight to the terminal.
export function MobileSessionAccessoryKeys({
  controller
}: {
  controller: MobileSessionController
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const {
    activeHandle,
    customKeys,
    setShowCustomKeyModal,
    setDeleteKeyTarget,
    visibleBuiltInIds,
    visibleBuiltInAccessoryKeys,
    terminalModes,
    canPaste,
    canSend,
    toggleDisplayMode,
    handleAccessoryKey,
    dismissSoftwareKeyboard,
    stopAccessoryRepeat,
    cancelAccessoryRepeat,
    prepareAccessoryPress,
    handlePaste,
    keyboardLift
  } = controller
  const accessoryPresses = useRef(new Map<string, ReturnType<typeof prepareAccessoryPress>>())
  const keepsKeyboard = useKeyboardPersistingTaps('always')
  // An unmounting Pressable never fires onPressOut, so a held key would outlive its row.
  useEffect(() => cancelAccessoryRepeat, [cancelAccessoryRepeat])
  const phoneDisplay = isTerminalPhoneDisplayMode(activeHandle, terminalModes)
  // A D-pad device's layout leaves the arrows to the rail, and this row only shows without the rail.
  const padAvailable = useDirectionPadAvailable()
  const builtInKeys = useMemo(
    () =>
      padAvailable
        ? getVisibleTerminalAccessoryKeys(visibleBuiltInIds, true)
        : visibleBuiltInAccessoryKeys,
    [padAvailable, visibleBuiltInIds, visibleBuiltInAccessoryKeys]
  )
  const keyStyle = ({ pressed }: { pressed: boolean }) => [
    styles.key,
    pressed && styles.keyPressed,
    !canSend && styles.disabled
  ]
  const sendKeyLabel = (label: string) =>
    t('session.accessoryKeys.sendKey', 'Send {{label}}', { label })
  return (
    <View ref={keepsKeyboard} style={styles.keyRow}>
      {/* Why: fixed keyboard escape hatch; outside the ScrollView so it can't scroll away (#5106). */}
      {keyboardLift > 0 && (
        <Pressable
          style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          onPress={dismissSoftwareKeyboard}
          hitSlop={TERMINAL_KEY_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={t('session.accessoryKeys.dismissKeyboard', 'Dismiss keyboard')}
          accessibilityHint={t(
            'session.accessoryKeys.dismissKeyboardHint',
            'Hides the software keyboard and keeps the current terminal session open.'
          )}
        >
          <View style={sessionStyles.keyboardDismissGlyph}>
            <KeyboardIcon size={15} color={colors.textPrimary} strokeWidth={2} />
            <ChevronDown
              size={10}
              color={colors.textPrimary}
              strokeWidth={2.5}
              style={sessionStyles.keyboardDismissChevron}
            />
          </View>
        </Pressable>
      )}
      {/* Why: default tap handling makes the first key tap dismiss the keyboard and get swallowed (#5106). */}
      <ScrollView
        style={styles.keyScroll}
        horizontal
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.keyScrollContent}
        keyboardShouldPersistTaps="always"
        onScrollBeginDrag={cancelAccessoryRepeat}
      >
        <Pressable
          style={keyStyle}
          disabled={!canSend}
          hitSlop={TERMINAL_KEY_HIT_SLOP}
          onPress={() => {
            if (activeHandle) {
              void toggleDisplayMode(activeHandle)
            }
          }}
          accessibilityRole="button"
          accessibilityLabel={
            phoneDisplay
              ? t('session.accessoryKeys.switchToDesktopMode', 'Switch to desktop mode')
              : t('session.accessoryKeys.switchToPhoneMode', 'Switch to phone mode')
          }
        >
          {phoneDisplay ? (
            <Monitor size={15} color={colors.textPrimary} strokeWidth={2} />
          ) : (
            <Smartphone size={15} color={colors.textPrimary} strokeWidth={2} />
          )}
        </Pressable>
        {canPaste && (
          <Pressable
            style={keyStyle}
            disabled={!canSend}
            hitSlop={TERMINAL_KEY_HIT_SLOP}
            onPress={() => void handlePaste()}
            accessibilityRole="button"
            accessibilityLabel={t(
              'session.accessoryKeys.pasteFromClipboard',
              'Paste from clipboard'
            )}
          >
            <Text style={styles.keyText}>{t('session.accessoryKeys.paste', 'Paste')}</Text>
          </Pressable>
        )}
        {builtInKeys.map((key) => (
          <Pressable
            key={key.id}
            style={keyStyle}
            disabled={!canSend}
            hitSlop={TERMINAL_KEY_HIT_SLOP}
            onPressIn={(event) => {
              if (!key.repeatable) {
                return
              }
              const press = prepareAccessoryPress(createTerminalLiveAccessoryInput(key))
              accessoryPresses.current.set(key.id, press)
              if (event.type === 'keydown') {
                press.hold(TERMINAL_ACCESSORY_REPEAT_DELAY_MS)
              }
            }}
            onPressOut={() => {
              if (key.repeatable) {
                stopAccessoryRepeat()
              }
            }}
            onPress={(event) => {
              if (key.repeatable) {
                // Accessibility clicks have no touch-down to prepare a sender.
                const accessibilityClick =
                  event.type === 'click' &&
                  'detail' in event.nativeEvent &&
                  event.nativeEvent.detail === 0
                const press =
                  (!accessibilityClick && accessoryPresses.current.get(key.id)) ||
                  prepareAccessoryPress(createTerminalLiveAccessoryInput(key))
                accessoryPresses.current.delete(key.id)
                void press.tap()
                return
              }
              void handleAccessoryKey(createTerminalLiveAccessoryInput(key))
            }}
            onLongPress={
              key.repeatable ? () => accessoryPresses.current.get(key.id)?.hold() : undefined
            }
            delayLongPress={TERMINAL_ACCESSORY_REPEAT_DELAY_MS}
            // A web <button> clicks on Enter keydown as well, which would send a held key twice.
            accessibilityRole={key.repeatable ? undefined : 'button'}
            accessibilityLabel={key.accessibilityLabel ?? sendKeyLabel(key.label)}
          >
            <Text style={styles.keyText}>{key.label}</Text>
          </Pressable>
        ))}
        {customKeys.map((key) => (
          <Pressable
            key={key.id}
            style={({ pressed }) => [...keyStyle({ pressed }), styles.customKey]}
            disabled={!canSend}
            hitSlop={TERMINAL_KEY_HIT_SLOP}
            onPress={() => void handleAccessoryKey({ bytes: key.bytes })}
            onLongPress={() => {
              triggerMediumImpact()
              setDeleteKeyTarget(key)
            }}
            delayLongPress={400}
            accessibilityRole="button"
            accessibilityLabel={sendKeyLabel(key.label)}
            accessibilityHint={t(
              'session.terminalMoreKeys.deleteKeyHint',
              'Long press to delete this key'
            )}
          >
            <Text style={styles.keyText}>{key.label}</Text>
          </Pressable>
        ))}
        <Pressable
          style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          hitSlop={TERMINAL_KEY_HIT_SLOP}
          onPress={() => setShowCustomKeyModal(true)}
          accessibilityRole="button"
          accessibilityLabel={t('session.accessoryKeys.addCustomShortcut', 'Add custom shortcut')}
        >
          <Plus size={15} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      </ScrollView>
    </View>
  )
}
