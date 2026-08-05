// ---------------------------------------------------------------------------
// Browser action recorder — in-page capture expressions
//
// Two standalone scripts injected into the recorded page via Runtime.evaluate:
// a compact DOM fingerprint snapshot, and the interaction/network capture
// script. The capture script is assembled from two halves (interaction
// listeners + network hooks) so each file stays under the max-lines gate.
// ---------------------------------------------------------------------------

import { INTERACTION_CAPTURE_NETWORK } from './browser-interaction-capture-network'
import { INTERACTION_CAPTURE_PREAMBLE } from './browser-interaction-capture-preamble'

// Why: a compact in-page snapshot is far cheaper than a full AX snapshot and
// still answers "did url/title/text/form state change" for every action.
export const DOM_FINGERPRINT_EXPRESSION = `(() => {
  try {
    const form = Array.from(document.querySelectorAll('input:not([type="password"]),textarea,select'))
    const inputsDetail = form.slice(0, 50).map(function (el, index) {
      var v = (el && 'value' in el ? el.value : '') || ''
      var label = el.id || el.name || el.getAttribute('aria-label') || el.type || el.tagName
      // Why: label collides for unnamed fields ('text' for every text input) —
      // key adds a stable identity so the diff never merges two fields.
      var key = el.id ? '#' + el.id : (el.name ? el.name + '[' + index + ']' : el.tagName.toLowerCase() + '[' + index + ']')
      return { key: key, label: label, value: v.length > 60 ? v.slice(0, 60) + '...' : v }
    })
    var text = (document.body && document.body.innerText) || ''
    return {
      url: location.href,
      title: document.title,
      textLength: text.length,
      interactive: document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"]').length,
      inputsDetail: inputsDetail,
      bodyText: text.slice(0, 4000)
    }
  } catch (e) {
    return { url: '', title: '', textLength: 0, interactive: 0, inputsDetail: [], bodyText: '' }
  }
})()`

// Why: while recording, manual page interactions and network traffic are
// reported to the main process as tagged console.debug lines (the recorder's
// console-message listener splits tagged lines into interaction/request
// events, everything else into console entries). Keydowns coalesce into typing
// bursts (flush on pause or non-printable key); scroll is throttled; hovers
// log on element change; fetch/XHR report on completion. One-shot: re-inject
// after a navigation to keep capturing. The two halves are concatenated so
// the injected script is a single IIFE.
export const INTERACTION_CAPTURE_EXPRESSION = `${INTERACTION_CAPTURE_PREAMBLE}${INTERACTION_CAPTURE_NETWORK}`
