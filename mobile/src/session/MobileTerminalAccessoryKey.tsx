import { Pressable, Text } from 'react-native'
import { useHoldPressTouchRef } from '../platform/hold-press-touch'
import type { TerminalAccessoryKey } from '../terminal/terminal-accessory-keys'
import {
  createTerminalLiveAccessoryInput,
  type TerminalLiveAccessoryInput
} from '../terminal/terminal-live-accessory-input'
import { styles } from './mobile-session-styles'

type Props = {
  readonly accessoryKey: TerminalAccessoryKey
  readonly canSend: boolean
  readonly onSend: (input: TerminalLiveAccessoryInput) => void
  readonly onRepeatStart: (input: TerminalLiveAccessoryInput) => void
  readonly onRepeatStop: () => void
}

/** A built-in key-bar key: repeatable keys send on press-in and repeat while held; others tap. */
export function MobileTerminalAccessoryKey({
  accessoryKey: key,
  canSend,
  onSend,
  onRepeatStart,
  onRepeatStop
}: Props) {
  // Only held keys take the guard: it cancels touchstart, which also drops the tap's click.
  const holdPressTouchRef = useHoldPressTouchRef(key.repeatable === true)
  return (
    <Pressable
      ref={holdPressTouchRef}
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
        onSend(input)
        onRepeatStart(input)
      }}
      onPressOut={() => {
        if (key.repeatable) {
          onRepeatStop()
        }
      }}
      onPress={() => {
        if (key.repeatable) {
          return
        }
        onSend(createTerminalLiveAccessoryInput(key))
      }}
      accessibilityLabel={key.accessibilityLabel ?? `Send ${key.label}`}
    >
      <Text style={[styles.accessoryKeyText, !canSend && styles.accessoryKeyTextDisabled]}>
        {key.label}
      </Text>
    </Pressable>
  )
}
