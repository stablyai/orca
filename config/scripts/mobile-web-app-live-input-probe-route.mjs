/**
 * The scratch route the terminal live-input check bundles, and the handles it drives.
 *
 * The session route cannot reach its own live input from a render check: the field is behind
 * `liveInputEnabled`, which is `liveInputTerminalHandles.has(activeHandle)`, and no handle exists
 * until the host protocol has been scripted through a tab snapshot and a terminal inventory. So
 * `liveInputRef.current` is null on that route and every native write on it is skipped by its own
 * optional chain. This route mounts the commit hook against a real `TextInput` instead, which is
 * the state a session on a device is in the moment a terminal attaches.
 *
 * This is a bundler entry and a page under test, not an assertion. The check itself stays the list
 * of things being measured.
 */

/** The terminal the probe's mirror state belongs to; every write below names it. */
export const LIVE_INPUT_HANDLE = 'live-input-probe-handle'
/** RN Web renders `nativeID` as the DOM `id`, which is how the check reads the field back. */
export const LIVE_INPUT_FIELD_ID = 'live-input-probe-field'
/** The buffered command field, which holds a draft until Enter sends it. */
export const BUFFERED_FIELD_ID = 'buffered-probe-field'

/**
 * The route: `useTerminalLiveInputCommit`, wired to a `TextInput` the way the command dock wires
 * it, down to `blurOnSubmit={false}` and the submit binding on the ref — which together decide
 * whether Enter reaches `onSubmitEditing` at all. Keystrokes therefore enter through the browser,
 * not through a handle that calls the hook directly.
 *
 * The mount effect is the other point. `use-mobile-session-startup.ts` calls
 * `clearPendingLiveInputCommit()` from an effect on every session mount, so a write the page
 * cannot honour throws under `PageFaultBoundary` and reaches the shell as a page fault rather than
 * as a rejected probe call. That is the emulator's symptom, reproduced where a browser can see it.
 */
export function liveInputProbeRouteSource({ bindingModule, commitModule, draftsModule }) {
  return `import { useCallback, useEffect, useRef, useState } from 'react'
import { TextInput, View } from 'react-native'
import { useTerminalLiveInputCommit } from ${JSON.stringify(commitModule)}
import { useTerminalTextFieldSubmitBinding } from ${JSON.stringify(bindingModule)}
import { useBufferedTerminalDrafts } from ${JSON.stringify(draftsModule)}

const HANDLE = ${JSON.stringify(LIVE_INPUT_HANDLE)}
const EMPTY_HANDLES = new Set()

export default function LiveInputProbeRoute() {
  const liveInputRef = useRef(null)
  const activeHandleRef = useRef(HANDLE)
  const activeSessionTabTypeRef = useRef('terminal')
  const [liveInputEnabled, setLiveInputEnabled] = useState(true)
  const liveInputTerminalHandlesRef = useRef(new Set([HANDLE]))
  const liveInputTerminalHandles = liveInputEnabled ? liveInputTerminalHandlesRef.current : EMPTY_HANDLES
  const sentRef = useRef([])
  const sendLiveTerminalInputRef = useRef((handle, payload) => {
    sentRef.current.push(payload)
    return Promise.resolve(true)
  })
  const [liveInputCapture, setLiveInputCapture] = useState('')
  const {
    clearPendingLiveInputCommit,
    handleLiveInputAccessoryBytes,
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
    liveInputTerminalHandles,
    liveInputTerminalHandlesRef,
    sendLiveTerminalInputRef,
    setLiveInputCapture
  })
  const onSubmitEditing = useCallback(() => {
    void handleLiveInputSubmit()
  }, [handleLiveInputSubmit])
  const bindLiveInputField = useTerminalTextFieldSubmitBinding(liveInputRef, onSubmitEditing)

  const activeHandleStateRef = useRef(HANDLE)
  const bufferedDrafts = useBufferedTerminalDrafts({
    activeHandle: HANDLE,
    activeHandleRef: activeHandleStateRef
  })
  const bufferedSentRef = useRef([])
  const commandInputRef = useRef(null)
  // The three calls use-mobile-session-terminal-send-actions.ts makes in handleSend, in that
  // order, with the RPC replaced by a record: begin clears the draft, the write goes out, settle
  // keeps it cleared. Nothing here re-implements the ordering rule, which its own source census pins.
  //
  // Per-render, like handleSend, and handed to both submit paths as the dock hands it to both.
  // What this route cannot catch is the wiring above it: a caller that freezes this closure in a
  // useCallback with an empty dependency list hands the binding one function forever, and no route
  // that writes its own submit can notice. That rule is pinned on the real source instead, in
  // terminal-field-submit-binding-wiring.test.ts.
  function sendBufferedDraft() {
    const draft = bufferedDrafts.input
    if (draft.length === 0) {
      return
    }
    const send = bufferedDrafts.beginBufferedTerminalDraftSend(HANDLE, draft)
    bufferedSentRef.current.push(draft)
    bufferedDrafts.settleBufferedTerminalDraftSend(send)
  }
  const bindCommandField = useTerminalTextFieldSubmitBinding(commandInputRef, sendBufferedDraft)

  // What use-mobile-session-startup.ts does on every session mount, in the same place.
  useEffect(() => {
    clearPendingLiveInputCommit()
  }, [clearPendingLiveInputCommit])

  useEffect(() => {
    globalThis.__orcaLiveInputProbe = {
      type: (text) => {
        handleLiveInputChange({ nativeEvent: { text } })
      },
      clear: () => {
        clearPendingLiveInputCommit()
      },
      // What use-mobile-session-terminal-send-actions.ts does with the result: 'allow-raw' means
      // the hook declined the input and the caller puts the bytes on the wire itself. Modelled
      // here so the check can see a control sent twice, or not at all.
      accessory: async (input) => {
        const result = await handleLiveInputAccessoryBytes(input)
        if (result.kind === 'allow-raw') {
          await sendLiveTerminalInputRef.current(HANDLE, input.bytes)
        }
        return result
      },
      sent: () => [...sentRef.current],
      bufferedSent: () => [...bufferedSentRef.current],
      setLiveInputEnabled
    }
  }, [clearPendingLiveInputCommit, handleLiveInputAccessoryBytes, handleLiveInputChange])

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
      <TextInput
        ref={bindCommandField}
        nativeID=${JSON.stringify(BUFFERED_FIELD_ID)}
        value={bufferedDrafts.input}
        onChangeText={bufferedDrafts.setInput}
        onSubmitEditing={sendBufferedDraft}
        blurOnSubmit={false}
        returnKeyType="send"
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
