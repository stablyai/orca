import {
  NATIVE_CHAT_VISUAL_HOST_CSP,
  NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE,
  NATIVE_CHAT_VISUAL_PING_TYPE,
  NATIVE_CHAT_VISUAL_PONG_TIMEOUT_MS,
  NATIVE_CHAT_VISUAL_PONG_TYPE,
  NATIVE_CHAT_VISUAL_SIZE_TYPE
} from '../../../../../src/shared/native-chat/native-chat-visual-shell'
import { inlineScriptLiteral } from '../../../components/inline-script-json'

/** `inline` sizes the frame to the height the app applies; `fullscreen` fills the screen and scrolls. */
export type MobileNativeChatVisualHostMode = 'inline' | 'fullscreen'

export const MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT = 160

export const MOBILE_NATIVE_CHAT_VISUAL_APPLY_HEIGHT = '__orcaVisualApplyHeight'

const SIZE_FORWARD_INTERVAL_MS = 100
const LINK_WINDOW_MS = 5_000

// The unsandboxed WebView loads only this trusted wrapper; author HTML stays in an opaque sandboxed child, whose srcdoc inherits this CSP.
// Relay only the child/channel’s messages and keep the app token private; load pings detect escapes, while CSP, sandbox and allowsLoad enforce navigation policy.
export function buildMobileNativeChatVisualHostDocument(input: {
  visualDocument: string
  /** The channel the visual document was built with; only messages on it are relayed. */
  channel: string
  token: string
  title: string
  mode: MobileNativeChatVisualHostMode
  pongTimeoutMs?: number
}): string {
  const frameHeight =
    input.mode === 'fullscreen' ? '100vh' : `${MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT}px`
  const constants = inlineScriptLiteral({
    token: input.token,
    channel: input.channel,
    fullscreen: input.mode === 'fullscreen',
    title: input.title,
    size: NATIVE_CHAT_VISUAL_SIZE_TYPE,
    link: NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE,
    applyHeight: MOBILE_NATIVE_CHAT_VISUAL_APPLY_HEIGHT,
    sizeIntervalMs: SIZE_FORWARD_INTERVAL_MS,
    linkWindowMs: LINK_WINDOW_MS,
    ping: NATIVE_CHAT_VISUAL_PING_TYPE,
    pong: NATIVE_CHAT_VISUAL_PONG_TYPE,
    pongTimeoutMs: input.pongTimeoutMs ?? NATIVE_CHAT_VISUAL_PONG_TIMEOUT_MS
  })
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${NATIVE_CHAT_VISUAL_HOST_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}iframe{display:block;border:0;width:100%;height:${frameHeight};background:transparent}</style>
</head>
<body>
<script>
(function () {
'use strict'
var C = ${constants}
var channel = window.ReactNativeWebView
function send(message) {
  message.token = C.token
  if (channel) channel.postMessage(JSON.stringify(message))
}
var frame = document.createElement('iframe')
frame.setAttribute('sandbox', 'allow-scripts')
frame.setAttribute('referrerpolicy', 'no-referrer')
frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'")
frame.setAttribute('title', C.title)
// iOS gives a scrollable frame its own scroll view, which takes a drag meant for the transcript;
// inline the frame is sized to its content (full screen still scrolls).
if (!C.fullscreen) frame.setAttribute('scrolling', 'no')
var loads = 0
var unanswered = null
function escaped() {
  frame.remove()
  send({ kind: 'escaped' })
}
frame.addEventListener('load', function () {
  loads += 1
  if (loads === 1) return
  if (unanswered) clearTimeout(unanswered.timer)
  unanswered = { id: loads, timer: setTimeout(escaped, C.pongTimeoutMs) }
  frame.contentWindow.postMessage({ type: C.ping, channel: C.channel, id: loads }, '*')
})
window[C.applyHeight] = function (height) {
  if (!C.fullscreen && typeof height === 'number' && isFinite(height)) frame.style.height = height + 'px'
}
var pendingSize = null
var sizeTimer = null
function flushSize() {
  sizeTimer = null
  if (pendingSize === null) return
  send({ kind: 'frame', data: pendingSize })
  pendingSize = null
}
var lastLinkAt = -Infinity
window.addEventListener('message', function (event) {
  if (!frame.contentWindow || event.source !== frame.contentWindow) return
  var data = event.data
  // The visual chooses every field, so only an exact channel match is relayed, as the host's own copy.
  if (!data || typeof data !== 'object' || data.channel !== C.channel) return
  if (data.type === C.pong) {
    if (unanswered && data.id === unanswered.id) {
      clearTimeout(unanswered.timer)
      unanswered = null
    }
    return
  }
  if (data.type === C.size) {
    if (C.fullscreen) return
    pendingSize = { type: C.size, channel: C.channel, height: Number(data.height) }
    if (sizeTimer === null) sizeTimer = setTimeout(flushSize, C.sizeIntervalMs)
    return
  }
  if (data.type === C.link) {
    var activation = navigator.userActivation
    var now = Date.now()
    if (document.activeElement !== frame || !activation || !activation.isActive) return
    if (typeof data.url !== 'string' || data.url.length > 4096) return
    if (now - lastLinkAt < C.linkWindowMs) return
    lastLinkAt = now
    send({ kind: 'frame', data: { type: C.link, channel: C.channel, url: data.url } })
  }
})
frame.srcdoc = ${inlineScriptLiteral(input.visualDocument)}
document.body.appendChild(frame)
})()
</script>
</body>
</html>`
}
