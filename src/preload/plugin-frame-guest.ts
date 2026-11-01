import type { ContextBridge, IpcRenderer } from 'electron'
import {
  installPluginFrameTransport,
  PRELOAD_PLUGIN_FRAME_IPC_CHANNEL,
  PRELOAD_PLUGIN_FRAME_KEY_CHANNEL,
  PRELOAD_PLUGIN_FRAME_TRANSPORT_GLOBAL
} from './plugin-frame-guest-transport'
import {
  createPluginFrameGestureTracker,
  createPluginFrameSendBudget,
  type PluginFrameSendRefusal
} from './plugin-frame-guest-send-budget'

// Raw require keeps the sandboxed preload standalone in the CJS build.
const electron: {
  contextBridge: ContextBridge
  ipcRenderer: Pick<IpcRenderer, 'sendToHost' | 'on'>
} = require('electron')
const { contextBridge, ipcRenderer } = electron

const admitSend = createPluginFrameSendBudget()
const gestures = createPluginFrameGestureTracker()
let receiver: ((message: unknown) => void) | null = null

// Capture listeners in the isolated world see every real input first; page script can neither
// forge `isTrusted` nor stop these from running.
window.addEventListener('pointerdown', (event) => gestures.note(event), true)
window.addEventListener(
  'keydown',
  (event) => {
    gestures.note(event)
    // Why its own channel: the page can post any envelope, so a save chord counts only from here.
    if (event.isTrusted && !event.repeat && (event.metaKey || event.ctrlKey)) {
      ipcRenderer.sendToHost(PRELOAD_PLUGIN_FRAME_KEY_CHANNEL, {
        key: String(event.key).slice(0, 64),
        code: String(event.code).slice(0, 64),
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey
      })
    }
  },
  true
)

/** A refused request still settles: the page gets the same error the host would have sent. */
function refuse(message: unknown, refusal: PluginFrameSendRefusal): void {
  const id =
    typeof message === 'object' &&
    message !== null &&
    'kind' in message &&
    message.kind === 'req' &&
    'id' in message
      ? message.id
      : null
  if (typeof id !== 'number' || !receiver) {
    return
  }
  const deliver = receiver
  const error = {
    code: refusal.code,
    message: refusal.code === 'too_large' ? 'message too large' : 'too many messages',
    retryable: refusal.code === 'rate_limited',
    ...(refusal.code === 'rate_limited' ? { retryAfterMs: refusal.retryAfterMs } : {})
  }
  queueMicrotask(() => deliver({ orca: 1, kind: 'res', id, error }))
}

// Why only HTML in the top frame: Orca's shell, which takes and hides the transport before plugin
// code runs, is injected only into HTML it serves. An SVG or XML document never gets one.
if (process.isMainFrame && document.contentType === 'text/html') {
  contextBridge.executeInMainWorld({
    func: installPluginFrameTransport,
    args: [
      PRELOAD_PLUGIN_FRAME_TRANSPORT_GLOBAL,
      // The gesture is read here, in the isolated world, so page script cannot forge it.
      (message: unknown) => {
        const refusal = admitSend(message)
        if (refusal) {
          refuse(message, refusal)
          return
        }
        ipcRenderer.sendToHost(PRELOAD_PLUGIN_FRAME_IPC_CHANNEL, message, {
          gesture: gestures.current(navigator.userActivation?.isActive === true)
        })
      },
      (receive: (message: unknown) => void) => {
        receiver = receive
        ipcRenderer.on(PRELOAD_PLUGIN_FRAME_IPC_CHANNEL, (_event, message: unknown) =>
          receive(message)
        )
      }
    ]
  })
}
