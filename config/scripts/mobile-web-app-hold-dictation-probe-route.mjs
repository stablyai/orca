/**
 * The scratch route the hold-to-dictate check bundles: both mic buttons in hold mode, with the
 * press-in/out handlers the session screens pass, minus the audio verbs behind them. What is under
 * test is react-native-web's press responder, so a press-in that only flips a flag is enough.
 */

/** RN Web renders `nativeID` as the DOM `id`; the check touches each mic through it. */
export const TERMINAL_MIC_ID = 'hold-probe-terminal-mic'
export const CHAT_MIC_ID = 'hold-probe-chat-mic'

export function holdDictationProbeRouteSource({ terminalActionsModule, chatComposerModule }) {
  return `import { useRef, useState } from 'react'
import { Text, View } from 'react-native'
import { MobileTerminalInputActions } from ${JSON.stringify(terminalActionsModule)}
import { MobileNativeChatComposer } from ${JSON.stringify(chatComposerModule)}

const noop = () => {}

export default function HoldDictationProbeRoute() {
  const [terminalHeld, setTerminalHeld] = useState(false)
  const [chatHeld, setChatHeld] = useState(false)
  const pressOutsRef = useRef({ terminal: 0, chat: 0 })
  globalThis.__orcaHoldDictationProbe = { pressOuts: () => ({ ...pressOutsRef.current }) }
  return (
    <View style={{ padding: 24, gap: 24 }}>
      <Text>Model</Text>
      <View nativeID=${JSON.stringify(TERMINAL_MIC_ID)} style={{ flexDirection: 'row' }}>
        <MobileTerminalInputActions
          canSend
          isAttaching={false}
          dictation={{ isStarting: false, isRecording: terminalHeld, isProcessing: false }}
          dictationMode="hold"
          buttonStyle={{ width: 48, height: 48 }}
          activeButtonStyle={null}
          disabledButtonStyle={null}
          onAttachImage={noop}
          onAttachFile={noop}
          onDictationToggle={noop}
          onDictationPressIn={() => setTerminalHeld(true)}
          onDictationPressOut={() => {
            pressOutsRef.current.terminal += 1
            setTerminalHeld(false)
          }}
          onDictationCancel={noop}
        />
      </View>
      <View nativeID=${JSON.stringify(CHAT_MIC_ID)}>
        <MobileNativeChatComposer
          value=""
          onChangeText={noop}
          onSend={() => Promise.resolve(false)}
          sendSurfaceId="hold-probe"
          getSendCompletionGeneration={() => 0}
          getComposerEditGeneration={() => 0}
          onMicPress={noop}
          micActive={chatHeld}
          dictationMode="hold"
          onMicPressIn={() => setChatHeld(true)}
          onMicPressOut={() => {
            pressOutsRef.current.chat += 1
            setChatHeld(false)
          }}
        />
      </View>
    </View>
  )
}
`
}
