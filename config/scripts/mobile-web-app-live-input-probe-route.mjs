/**
 * The scratch route the terminal live-input check bundles, and the handles it drives.
 *
 * The session route cannot reach its own live input from a render check: the field is behind
 * `liveInputEnabled`, which is `liveInputTerminalHandles.has(activeHandle)`, and no handle exists
 * until the host protocol has been scripted through a tab snapshot and a terminal inventory. So
 * `liveInputRef.current` is null on that route and every native write on it is skipped by its own
 * optional chain. This route mounts the two hooks against a real `TextInput` instead, which is the
 * state a session on a device is in the moment a terminal attaches.
 *
 * This is a bundler entry and a page under test, not an assertion. The check itself stays the list
 * of things being measured.
 */

/** The terminal the probe's mirror state belongs to; every write below names it. */
export const LIVE_INPUT_HANDLE = 'live-input-probe-handle'
/** RN Web renders `nativeID` as the DOM `id`, which is how the check reads the field back. */
export const LIVE_INPUT_FIELD_ID = 'live-input-probe-field'

/**
 * The route: both live-input hooks, wired to each other the way the session screen wires them.
 *
 * The mount effect is the point. `use-mobile-session-startup.ts` calls
 * `clearPendingLiveInputCommit()` from an effect on every session mount, so a write the page
 * cannot honour throws under `PageFaultBoundary` and reaches the shell as a page fault rather than
 * as a rejected probe call. That is the emulator's symptom, reproduced where a browser can see it.
 */
export function liveInputProbeRouteSource({ accessoryModule, flushModule }) {
  return `import { useCallback, useEffect, useRef, useState } from 'react'
import { TextInput, View } from 'react-native'
import { useTerminalLivePendingInputFlush } from ${JSON.stringify(flushModule)}
import { useTerminalLiveAccessoryInputCommit } from ${JSON.stringify(accessoryModule)}

const HANDLE = ${JSON.stringify(LIVE_INPUT_HANDLE)}

export default function LiveInputProbeRoute() {
  const liveInputRef = useRef(null)
  const activeHandleRef = useRef(HANDLE)
  const activeSessionTabTypeRef = useRef('terminal')
  const liveInputTerminalHandlesRef = useRef(new Set([HANDLE]))
  const sentRef = useRef([])
  const sendLiveTerminalInputRef = useRef((handle, payload) => {
    sentRef.current.push(payload)
    return Promise.resolve(true)
  })
  const [liveInputCapture, setLiveInputCapture] = useState('')
  const {
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    flushPendingLiveInputText,
    heldLiveInputTextRef,
    liveInputComposingRef,
    pendingLiveInputHandleRef,
    sentLiveInputTextRef,
    waitForPendingLiveInputFlush
  } = useTerminalLivePendingInputFlush({
    activeHandleRef,
    activeSessionTabTypeRef,
    liveInputRef,
    liveInputTerminalHandlesRef,
    sendLiveTerminalInputRef,
    setLiveInputCapture
  })
  const onInteraction = useCallback(() => {}, [])
  const commitAccessoryInput = useTerminalLiveAccessoryInputCommit({
    activeHandle: HANDLE,
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    flushPendingLiveInputText,
    heldLiveInputTextRef,
    liveInputComposingRef,
    liveInputRef,
    liveInputTerminalHandles: liveInputTerminalHandlesRef.current,
    onInteraction,
    pendingLiveInputHandleRef,
    sentLiveInputTextRef,
    sendLiveTerminalInputRef,
    setLiveInputCapture,
    waitForPendingLiveInputFlush
  })

  // What use-mobile-session-startup.ts does on every session mount, in the same place.
  useEffect(() => {
    clearPendingLiveInputCommit()
  }, [clearPendingLiveInputCommit])

  useEffect(() => {
    globalThis.__orcaLiveInputProbe = {
      type: (text) => {
        setLiveInputCapture(text)
        return applyLiveInputMirror(HANDLE, text)
      },
      clear: () => {
        clearPendingLiveInputCommit()
      },
      accessory: (input) => commitAccessoryInput(input),
      sent: () => [...sentRef.current]
    }
  }, [applyLiveInputMirror, clearPendingLiveInputCommit, commitAccessoryInput])

  return (
    <View testID="live-input-probe">
      <TextInput
        ref={liveInputRef}
        nativeID=${JSON.stringify(LIVE_INPUT_FIELD_ID)}
        value={liveInputCapture}
        onChangeText={setLiveInputCapture}
        style={{ fontSize: 16 }}
      />
    </View>
  )
}
`
}
