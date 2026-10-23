import { useState, type Dispatch, type SetStateAction } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import { ArrowUp, ChevronDown, Keyboard as KeyboardIcon } from 'lucide-react-native'
import { AutoHeight } from '../components/ui/AutoHeight'
import { IconButton } from '../components/ui/IconButton'
import { pressTransition } from '../components/ui/transition-styles'
import { MobileTerminalInputRoundButton } from '../session/MobileTerminalInputActions'
import { colors } from '../theme/mobile-theme'
import { MobileBrowserKeyRow } from './MobileBrowserKeyRow'
import {
  BROWSER_POINTER_MODIFIERS,
  MobileBrowserPointerModifiers,
  type BrowserPointerModifier
} from './MobileBrowserPointerModifiers'
import { mobileBrowserPaneStyles as styles } from './mobile-browser-pane-styles'

type Props = {
  bottomInset: number
  keyboardLift: number
  controlsDisabled: boolean
  pointerModifiers: BrowserPointerModifier[]
  togglePointerModifier: (modifier: BrowserPointerModifier) => void
  sendKeypress: (key: string) => Promise<void>
  keyboardValue: string
  setKeyboardValue: Dispatch<SetStateAction<string>>
  sendKeyboardText: () => Promise<void>
}

/** Typing into the page: one "Type on page" capsule that opens the field, keys and click modifiers. */
export function MobileBrowserTypingDock({
  bottomInset,
  keyboardLift,
  controlsDisabled,
  pointerModifiers,
  togglePointerModifier,
  sendKeypress,
  keyboardValue,
  setKeyboardValue,
  sendKeyboardText
}: Props) {
  // Why: the controls take ~150 pt; most of the time the page is read, so they open on demand.
  const [typingOpen, setTypingOpen] = useState(false)
  const [keyboardFocused, setKeyboardFocused] = useState(false)
  const heldModifiers = BROWSER_POINTER_MODIFIERS.filter((modifier) =>
    pointerModifiers.includes(modifier.id)
  )
    .map((modifier) => modifier.label)
    .join(' + ')
  return (
    <View
      style={[
        styles.keyboardDock,
        { paddingBottom: bottomInset, transform: [{ translateY: -keyboardLift }] }
      ]}
    >
      {/* The capsule and the controls trade places; the dock eases between their heights. */}
      <AutoHeight>
        {typingOpen ? (
          <>
            <View style={styles.dockKeys}>
              <MobileBrowserPointerModifiers
                disabled={controlsDisabled}
                selectedModifiers={pointerModifiers}
                onToggle={togglePointerModifier}
              />
              <View style={styles.dockKeysRow}>
                <MobileBrowserKeyRow
                  disabled={controlsDisabled}
                  onKeypress={(key) => void sendKeypress(key)}
                />
                <IconButton
                  icon={ChevronDown}
                  variant="bare"
                  iconSize={20}
                  iconColor={colors.textSecondary}
                  onPress={() => setTypingOpen(false)}
                  accessibilityLabel="Hide typing controls"
                />
              </View>
            </View>
            <View style={styles.inputRow}>
              <View
                style={[
                  styles.inputBox,
                  keyboardFocused && styles.inputBoxFocused,
                  controlsDisabled && styles.disabled
                ]}
              >
                <TextInput
                  style={styles.keyboardInput}
                  value={keyboardValue}
                  onChangeText={setKeyboardValue}
                  onFocus={() => setKeyboardFocused(true)}
                  onBlur={() => setKeyboardFocused(false)}
                  placeholder="Type on page…"
                  placeholderTextColor={colors.textMuted}
                  selectionColor={colors.accentBlue}
                  accessibilityLabel="Text to type on the page"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  editable={!controlsDisabled}
                  onSubmitEditing={() => void sendKeyboardText()}
                />
                <MobileTerminalInputRoundButton
                  ready={!controlsDisabled && !!keyboardValue}
                  soft={!keyboardValue}
                  disabled={controlsDisabled || !keyboardValue}
                  onPress={() => void sendKeyboardText()}
                  accessibilityLabel="Send text to browser"
                >
                  <ArrowUp
                    size={17}
                    color={!controlsDisabled && keyboardValue ? colors.onPrimary : colors.textMuted}
                    strokeWidth={2.4}
                  />
                </MobileTerminalInputRoundButton>
              </View>
            </View>
          </>
        ) : (
          <View style={styles.inputRow}>
            <Pressable
              disabled={controlsDisabled}
              onPress={() => setTypingOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Type on page"
              accessibilityHint="Shows a field, keys and click modifiers for this page"
            >
              {({ pressed }) => (
                <View
                  style={[
                    styles.typeTrigger,
                    pressed && styles.typeTriggerPressed,
                    controlsDisabled && styles.disabled,
                    pressed ? pressTransition.pressed : pressTransition.rest
                  ]}
                >
                  <KeyboardIcon size={18} color={colors.textSecondary} strokeWidth={2} />
                  <Text style={styles.typeTriggerText} numberOfLines={1}>
                    Type on page…
                  </Text>
                  {heldModifiers ? (
                    <Text style={styles.typeTriggerHint} numberOfLines={1}>
                      {`${heldModifiers} + click`}
                    </Text>
                  ) : null}
                </View>
              )}
            </Pressable>
          </View>
        )}
      </AutoHeight>
    </View>
  )
}
