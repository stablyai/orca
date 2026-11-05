// No-RPC session has no active handle/live field, so optional ref chain skips native-write defects.
// Mount commit hook against real TextInput like attached device session; this file is probe entry, assertions live in render suite.

export const LIVE_INPUT_HANDLE = 'live-input-probe-handle'
export const LIVE_INPUT_FIELD_ID = 'live-input-probe-field'

// Match dock’s blurOnSubmit=false and ref submit binding; send real browser keystrokes, not direct hook calls.
// Clear in mount effect like session startup so unsupported DOM writes reach PageFaultBoundary as actual page fault.
export function liveInputProbeRouteSource({ bindingModule, commitModule }) {
  return `import { useCallback, useEffect, useRef, useState } from 'react'
import { TextInput, View } from 'react-native'
import { useTerminalLiveInputCommit } from ${JSON.stringify(commitModule)}
import { useTerminalTextFieldSubmitBinding } from ${JSON.stringify(bindingModule)}

const HANDLE = ${JSON.stringify(LIVE_INPUT_HANDLE)}

export default function LiveInputProbeRoute() {
  const liveInputRef = useRef(null)
  const activeHandleRef = useRef(HANDLE)
  const activeSessionTabTypeRef = useRef('terminal')
  const sentRef = useRef([])
  const sendLiveTerminalInputRef = useRef((handle, payload) => {
    sentRef.current.push(payload)
    return Promise.resolve(true)
  })
  const [liveInputCapture, setLiveInputCapture] = useState('')
  const {
    clearPendingLiveInputCommit,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    handleLiveInputSubmit
  } = useTerminalLiveInputCommit({
    activeHandle: HANDLE,
    activeHandleRef,
    activeSessionTabType: 'terminal',
    activeSessionTabTypeRef,
    connected: true,
    liveInputRef,
    sendLiveTerminalInputRef,
    setLiveInputCapture
  })
  const onSubmitEditing = useCallback(() => {
    void handleLiveInputSubmit()
  }, [handleLiveInputSubmit])
  const bindLiveInputField = useTerminalTextFieldSubmitBinding(liveInputRef, onSubmitEditing)

  // What use-mobile-session-startup.ts does on every session mount, in the same place.
  useEffect(() => {
    clearPendingLiveInputCommit()
  }, [clearPendingLiveInputCommit])

  useEffect(() => {
    globalThis.__orcaLiveInputProbe = {
      sent: () => [...sentRef.current]
    }
  }, [])

  return (
    <View testID="live-input-probe">
      <TextInput
        ref={bindLiveInputField}
        nativeID=${JSON.stringify(LIVE_INPUT_FIELD_ID)}
        value={liveInputCapture}
        onChange={handleLiveInputChange}
        onKeyPress={handleLiveInputKeyPress}
        onSubmitEditing={onSubmitEditing}
        blurOnSubmit={false}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        style={{ fontSize: 16 }}
      />
    </View>
  )
}
`
}
