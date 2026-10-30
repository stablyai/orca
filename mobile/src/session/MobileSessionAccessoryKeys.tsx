import { useEffect, useRef } from 'react'
import { View, Text, ScrollView, Pressable } from 'react-native'
import {
  ChevronDown,
  ChevronsRight,
  Keyboard as KeyboardIcon,
  Monitor,
  Plus,
  Smartphone
} from 'lucide-react-native'
import { triggerMediumImpact } from '../platform/haptics'
import { createTerminalLiveAccessoryInput } from '../terminal/terminal-live-accessory-input'
import { TERMINAL_ACCESSORY_REPEAT_DELAY_MS } from '../terminal/terminal-accessory-repeat'
import { isTerminalPhoneDisplayMode } from './mobile-session-route-helpers'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-session-styles'
import { useKeyboardPersistingTaps } from '../platform/keyboard-persisting-taps'
import type { MobileSessionController } from './use-mobile-session-controller'

// The terminal's key strip: a row above the input, or a column in the Duo's side rail.
export function MobileSessionAccessoryKeys({
  controller,
  vertical = false
}: {
  controller: MobileSessionController
  vertical?: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const {
    activeHandle,
    customKeys,
    setShowCustomKeyModal,
    setDeleteKeyTarget,
    visibleBuiltInAccessoryKeys,
    terminalModes,
    canPaste,
    canSend,
    canCompose,
    liveInputEnabled,
    toggleDisplayMode,
    handleAccessoryKey,
    dismissSoftwareKeyboard,
    toggleLiveInput,
    stopAccessoryRepeat,
    cancelAccessoryRepeat,
    prepareAccessoryPress,
    handlePaste,
    keyboardLift
  } = controller
  const accessoryPresses = useRef(new Map<string, ReturnType<typeof prepareAccessoryPress>>())
  const keepsKeyboard = useKeyboardPersistingTaps('always')
  // An unmounting Pressable never fires onPressOut, so a held key would outlive its strip.
  useEffect(() => cancelAccessoryRepeat, [cancelAccessoryRepeat])
  return (
    <View ref={keepsKeyboard} style={vertical ? styles.accessoryRail : styles.accessoryBar}>
      {/* Why: fixed keyboard escape hatch; outside ScrollView + shortcut path so it can't scroll away or be hidden (#5106). */}
      {keyboardLift > 0 && (
        <Pressable
          style={({ pressed }) => [
            vertical ? styles.keyboardDismissKeyVertical : styles.keyboardDismissKey,
            pressed && styles.accessoryKeyPressed
          ]}
          onPress={dismissSoftwareKeyboard}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('session.accessoryKeys.dismissKeyboard', 'Dismiss keyboard')}
          accessibilityHint={t(
            'session.accessoryKeys.dismissKeyboardHint',
            'Hides the software keyboard and keeps the current terminal session open.'
          )}
        >
          <View style={styles.keyboardDismissGlyph}>
            <KeyboardIcon size={15} color={colors.textSecondary} strokeWidth={2} />
            <ChevronDown
              size={10}
              color={colors.textSecondary}
              strokeWidth={2.5}
              style={styles.keyboardDismissChevron}
            />
          </View>
        </Pressable>
      )}
      {/* Why: default tap handling makes the first accessory-key tap dismiss the keyboard and get swallowed (#5106). */}
      <ScrollView
        style={vertical ? styles.accessoryScrollVertical : styles.accessoryScroll}
        horizontal={!vertical}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={vertical ? styles.accessoryContentVertical : styles.accessoryContent}
        keyboardShouldPersistTaps="always"
        onScrollBeginDrag={cancelAccessoryRepeat}
      >
        <Pressable
          style={({ pressed }) => [
            styles.accessoryKey,
            vertical && styles.accessoryKeyVertical,
            pressed && styles.accessoryKeyPressed,
            !canSend && styles.accessoryKeyDisabled
          ]}
          disabled={!canSend}
          onPress={() => {
            if (activeHandle) {
              void toggleDisplayMode(activeHandle)
            }
          }}
          accessibilityLabel={
            isTerminalPhoneDisplayMode(activeHandle, terminalModes)
              ? t('session.accessoryKeys.switchToDesktopMode', 'Switch to desktop mode')
              : t('session.accessoryKeys.switchToPhoneMode', 'Switch to phone mode')
          }
        >
          {isTerminalPhoneDisplayMode(activeHandle, terminalModes) ? (
            <Monitor size={14} color={canSend ? colors.textSecondary : colors.textMuted} />
          ) : (
            <Smartphone size={14} color={canSend ? colors.textSecondary : colors.textMuted} />
          )}
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.accessoryKey,
            vertical && styles.accessoryKeyVertical,
            liveInputEnabled && styles.accessoryKeyActive,
            pressed && styles.accessoryKeyPressed,
            !canCompose && styles.accessoryKeyDisabled
          ]}
          // Why: offline, live mode is dead but the buffered box still composes — keep the escape hatch tappable (#6713).
          disabled={!canCompose}
          onPress={toggleLiveInput}
          accessibilityLabel={
            liveInputEnabled
              ? t('session.accessoryKeys.switchToBufferedInput', 'Switch to buffered command input')
              : t('session.accessoryKeys.switchToLiveInput', 'Switch to live terminal input')
          }
        >
          <ChevronsRight
            size={14}
            color={
              liveInputEnabled
                ? colors.bgBase
                : canCompose
                  ? colors.textSecondary
                  : colors.textMuted
            }
          />
        </Pressable>
        {canPaste && (
          <Pressable
            style={({ pressed }) => [
              styles.accessoryKey,
              vertical && styles.accessoryKeyVertical,
              vertical && styles.accessoryKeyVertical,
              pressed && styles.accessoryKeyPressed,
              !canSend && styles.accessoryKeyDisabled
            ]}
            disabled={!canSend}
            onPress={() => void handlePaste()}
            accessibilityLabel={t(
              'session.accessoryKeys.pasteFromClipboard',
              'Paste from clipboard'
            )}
          >
            <Text style={[styles.accessoryKeyText, !canSend && styles.accessoryKeyTextDisabled]}>
              {t('session.accessoryKeys.paste', 'Paste')}
            </Text>
          </Pressable>
        )}
        {visibleBuiltInAccessoryKeys.map((key) => (
          <Pressable
            key={key.id}
            style={({ pressed }) => [
              styles.accessoryKey,
              vertical && styles.accessoryKeyVertical,
              vertical && styles.accessoryKeyVertical,
              pressed && styles.accessoryKeyPressed,
              !canSend && styles.accessoryKeyDisabled
            ]}
            disabled={!canSend}
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
            accessibilityLabel={
              key.accessibilityLabel ??
              t('session.accessoryKeys.sendKey', 'Send {{label}}', { label: key.label })
            }
          >
            <Text style={[styles.accessoryKeyText, !canSend && styles.accessoryKeyTextDisabled]}>
              {key.label}
            </Text>
          </Pressable>
        ))}
        {customKeys.map((key) => (
          <Pressable
            key={key.id}
            style={({ pressed }) => [
              styles.accessoryKey,
              vertical && styles.accessoryKeyVertical,
              vertical && styles.accessoryKeyVertical,
              styles.customAccessoryKey,
              pressed && styles.accessoryKeyPressed,
              !canSend && styles.accessoryKeyDisabled
            ]}
            disabled={!canSend}
            onPress={() => void handleAccessoryKey({ bytes: key.bytes })}
            onLongPress={() => {
              triggerMediumImpact()
              setDeleteKeyTarget(key)
            }}
            delayLongPress={400}
            accessibilityLabel={t('session.accessoryKeys.sendKey', 'Send {{label}}', {
              label: key.label
            })}
          >
            <Text style={[styles.accessoryKeyText, !canSend && styles.accessoryKeyTextDisabled]}>
              {key.label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          style={({ pressed }) => [
            styles.accessoryKey,
            vertical && styles.accessoryKeyVertical,
            pressed && styles.accessoryKeyPressed
          ]}
          onPress={() => setShowCustomKeyModal(true)}
          accessibilityLabel={t('session.accessoryKeys.addCustomShortcut', 'Add custom shortcut')}
        >
          <Plus size={14} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
      </ScrollView>
    </View>
  )
}
