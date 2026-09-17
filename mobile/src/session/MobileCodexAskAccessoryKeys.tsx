import { useEffect, useRef, useState } from 'react'
import { Pressable, Text } from 'react-native'
import type { AskPrompt } from '../../../src/shared/native-chat-ask'
import { styles } from './mobile-session-styles'

type Props = {
  ask: AskPrompt
  askKey: string | null
  onAnswer: () => void
  onSkip?: (ask: AskPrompt) => Promise<boolean>
}

/** Terminal-dock quick keys while a Codex question waits: Answer opens the chat
 *  wizard, Skip drives DEL + Proceed. The latch keeps Skip from double-writing
 *  DEL into an overlay whose blocked status has not cleared yet. */
export function MobileCodexAskAccessoryKeys({ ask, askKey, onAnswer, onSkip }: Props) {
  const [inFlight, setInFlight] = useState(false)
  const inFlightRef = useRef(false)
  useEffect(() => {
    inFlightRef.current = false
    setInFlight(false)
  }, [askKey])
  return (
    <>
      <Pressable
        style={({ pressed }) => [
          styles.accessoryKey,
          styles.accessoryKeyActive,
          pressed && styles.accessoryKeyPressed
        ]}
        onPress={onAnswer}
        accessibilityLabel="Answer the pending question"
      >
        <Text style={styles.accessoryKeyTextActive}>Answer</Text>
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.accessoryKey,
          pressed && styles.accessoryKeyPressed,
          inFlight && styles.accessoryKeyDisabled
        ]}
        disabled={inFlight || !onSkip}
        onPress={() => {
          if (!onSkip || inFlightRef.current) {
            return
          }
          inFlightRef.current = true
          setInFlight(true)
          void onSkip(ask).then((accepted) => {
            if (!accepted) {
              inFlightRef.current = false
              setInFlight(false)
            }
          })
        }}
        accessibilityLabel="Skip the pending question"
      >
        <Text style={[styles.accessoryKeyText, inFlight && styles.accessoryKeyTextDisabled]}>
          Skip
        </Text>
      </Pressable>
    </>
  )
}
