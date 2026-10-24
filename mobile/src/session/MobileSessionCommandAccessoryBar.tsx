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
import { keepHeldPressThroughLongPress } from './held-press-long-press'
import { isTerminalPhoneDisplayMode } from './mobile-session-route-helpers'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-session-styles'
import { useKeyboardPersistingTaps } from '../platform/keyboard-persisting-taps'
import type { MobileSessionController } from './use-mobile-session-controller'

/** Shortcut row above the command field. The dismiss key stays outside the scroller. */
export function MobileSessionCommandAccessoryBar({
  controller
}: {
  controller: MobileSessionController
}) {
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
    startAccessoryRepeat,
    handlePaste,
    keyboardLift
  } = controller
  const accessoryBarKeepsKeyboard = useKeyboardPersistingTaps('always')
  return (
    <View ref={accessoryBarKeepsKeyboard} style={styles.accessoryBar}>
      {/* Why: fixed keyboard escape hatch; outside ScrollView + shortcut path so it can't scroll away or be hidden (#5106). */}
      {keyboardLift > 0 && (
        <Pressable
          style={({ pressed }) => [
            styles.keyboardDismissKey,
            pressed && styles.accessoryKeyPressed
          ]}
          onPress={dismissSoftwareKeyboard}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss keyboard"
          accessibilityHint="Hides the software keyboard and keeps the current terminal session open."
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
        style={styles.accessoryScroll}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.accessoryContent}
        keyboardShouldPersistTaps="always"
      >
        <Pressable
          style={({ pressed }) => [
            styles.accessoryKey,
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
              ? 'Switch to desktop mode'
              : 'Switch to phone mode'
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
            liveInputEnabled && styles.accessoryKeyActive,
            pressed && styles.accessoryKeyPressed,
            !canCompose && styles.accessoryKeyDisabled
          ]}
          // Why: offline, live mode is dead but the buffered box still composes — keep the escape hatch tappable (#6713).
          disabled={!canCompose}
          onPress={toggleLiveInput}
          accessibilityLabel={
            liveInputEnabled ? 'Switch to buffered command input' : 'Switch to live terminal input'
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
              pressed && styles.accessoryKeyPressed,
              !canSend && styles.accessoryKeyDisabled
            ]}
            disabled={!canSend}
            onPress={() => void handlePaste()}
            accessibilityLabel="Paste from clipboard"
          >
            <Text style={[styles.accessoryKeyText, !canSend && styles.accessoryKeyTextDisabled]}>
              Paste
            </Text>
          </Pressable>
        )}
        {visibleBuiltInAccessoryKeys.map((key) => (
          <Pressable
            key={key.id}
            style={({ pressed }) => [
              styles.accessoryKey,
              pressed && styles.accessoryKeyPressed,
              !canSend && styles.accessoryKeyDisabled
            ]}
            disabled={!canSend}
            onPressIn={() => {
              if (!key.repeatable) {
                return
              }
              const input = createTerminalLiveAccessoryInput(key)
              void handleAccessoryKey(input)
              startAccessoryRepeat(input)
            }}
            onPressOut={() => {
              if (key.repeatable) {
                stopAccessoryRepeat()
              }
            }}
            onPress={() => {
              if (key.repeatable) {
                return
              }
              void handleAccessoryKey(createTerminalLiveAccessoryInput(key))
            }}
            onLongPress={key.repeatable ? keepHeldPressThroughLongPress : undefined}
            accessibilityLabel={key.accessibilityLabel ?? `Send ${key.label}`}
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
            accessibilityLabel={`Send ${key.label}`}
          >
            <Text style={[styles.accessoryKeyText, !canSend && styles.accessoryKeyTextDisabled]}>
              {key.label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          style={({ pressed }) => [styles.accessoryKey, pressed && styles.accessoryKeyPressed]}
          onPress={() => setShowCustomKeyModal(true)}
          accessibilityLabel="Add custom shortcut"
        >
          <Plus size={14} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
      </ScrollView>
    </View>
  )
}
