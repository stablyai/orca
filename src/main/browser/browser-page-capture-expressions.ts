// ---------------------------------------------------------------------------
// Browser action recorder — in-page capture expressions
//
// Two standalone scripts injected into the recorded page via Runtime.evaluate.
// ---------------------------------------------------------------------------

// Why: a compact in-page snapshot is far cheaper than a full AX snapshot and
// still answers "did url/title/text/form state change" for every action.
export const DOM_FINGERPRINT_EXPRESSION = `(() => {
  try {
    const form = Array.from(document.querySelectorAll('input:not([type="password"]),textarea,select'))
    const inputsDetail = form.slice(0, 50).map(function (el) {
      var v = (el && 'value' in el ? el.value : '') || ''
      var label = el.id || el.name || el.getAttribute('aria-label') || el.type || el.tagName
      return { label: label, value: v.length > 60 ? v.slice(0, 60) + '...' : v }
    })
    var text = (document.body && document.body.innerText) || ''
    return {
      url: location.href,
      title: document.title,
      textLength: text.length,
      interactive: document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"]').length,
      inputsDetail: inputsDetail
    }
  } catch (e) {
    return { url: '', title: '', textLength: 0, interactive: 0, inputsDetail: [] }
  }
})()`

// Why: while recording, manual page interactions and network traffic are
// reported to the main process as tagged console.debug lines (the recorder's
// console-message listener splits tagged lines into interaction/request
// events, everything else into console entries). Keydowns coalesce into typing
// bursts (flush on pause or non-printable key); scroll is throttled; hovers
// log on element change; fetch/XHR report on completion. One-shot: re-inject
// after a navigation to keep capturing.
export const INTERACTION_CAPTURE_EXPRESSION = `(() => {
  if (window.__orcaRecorderInstalled) { return 'already-installed' }
  window.__orcaRecorderInstalled = true
  var TAG = '__orca_recorder__'
  function report(type, payload) {
    try { console.debug(TAG, JSON.stringify(Object.assign({ type: type }, payload))) } catch (e) {}
  }
  function summarize(el) {
    if (!el || !el.tagName) { return '' }
    if (el.id) { return '#' + el.id }
    var cls = typeof el.className === 'string' ? el.className.split(/\\s+/)[0] : ''
    if (cls) { return el.tagName.toLowerCase() + '.' + cls }
    var name = el.getAttribute && el.getAttribute('name')
    if (name) { return el.tagName.toLowerCase() + '[name=' + name + ']' }
    return el.tagName.toLowerCase()
  }
  // ── typing burst coalescing ──
  var typing = { text: '', target: '', lastAt: 0, timer: null }
  var TYPE_PAUSE_MS = 450
  function flushTyping() {
    if (typing.timer) { clearTimeout(typing.timer); typing.timer = null }
    if (typing.text.length > 0) {
      report('type', { text: typing.text, target: typing.target })
      typing.text = ''
    }
  }
  function scheduleFlush() {
    if (typing.timer) { clearTimeout(typing.timer) }
    typing.timer = setTimeout(flushTyping, TYPE_PAUSE_MS)
  }
  var PRINTABLE = /^[ -~\\u00a0-\\uffff]$/
  function isPrintableKey(key) {
    return key && key.length === 1 && PRINTABLE.test(key)
  }
  function isPasswordField(el) {
    if (!el) { return false }
    if (el.type === 'password') { return true }
    var name = String(el.name || el.id || '')
    return /password|passwd|sifre|parola/i.test(name)
  }
  document.addEventListener('keydown', function (e) {
    var target = summarize(document.activeElement)
    if (isPrintableKey(e.key)) {
      // Why: never leak typed password content into the recording log; keep
      // the marker length so the burst still reads as "something typed here".
      if (isPasswordField(document.activeElement)) {
        typing.text += '•'
      } else {
        typing.text += e.key
      }
      typing.target = target
      typing.lastAt = Date.now()
      scheduleFlush()
      return
    }
    flushTyping()
    if (e.key && e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') {
      report('keydown', { key: e.key, target: target })
    }
  }, true)
  document.addEventListener('click', function (e) {
    flushTyping()
    var t = e.target
    report('click', { x: e.clientX, y: e.clientY, target: summarize(t), tagName: t && t.tagName ? t.tagName.toLowerCase() : '' })
  }, true)
  // ── hover (element change, throttled) ──
  var lastHover = { target: '', at: 0 }
  document.addEventListener('mouseover', function (e) {
    var now = Date.now()
    if (now - lastHover.at < 300) { return }
    var target = summarize(e.target)
    if (target === lastHover.target) { return }
    lastHover = { target: target, at: now }
    report('hover', { target: target, tagName: e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '' })
  }, true)
  // ── scroll (throttled) ──
  var lastScroll = 0
  document.addEventListener('scroll', function () {
    var now = Date.now()
    if (now - lastScroll < 1000) { return }
    lastScroll = now
    report('scroll', { x: Math.round(window.scrollX || 0), y: Math.round(window.scrollY || 0) })
  }, true)
  // ── network requests (fetch + XHR, report on completion) ──
  var nativeFetch = window.fetch
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || ''
      var method = (init && init.method) || (input && input.method) || 'GET'
      var body = init && init.body ? String(init.body) : ''
      var started = Date.now()
      return nativeFetch.apply(this, arguments).then(function (res) {
        report('request', { method: method, url: url, body: body, status: res.status, durationMs: Date.now() - started })
        return res
      }, function (err) {
        report('request', { method: method, url: url, body: body, status: -1, durationMs: Date.now() - started })
        throw err
      })
    }
  }
  var nativeOpen = XMLHttpRequest.prototype.open
  var nativeSend = XMLHttpRequest.prototype.send
  var pending = new WeakMap()
  XMLHttpRequest.prototype.open = function (method, url) {
    pending.set(this, { method: String(method), url: String(url), body: '', started: Date.now() })
    return nativeOpen.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function (body) {
    var info = pending.get(this)
    if (info) { info.body = body == null ? '' : String(body) }
    return nativeSend.apply(this, arguments)
  }
  XMLHttpRequest.prototype.addEventListener.call(XMLHttpRequest.prototype, 'loadend', function () {
    var info = pending.get(this)
    if (!info) { return }
    pending.delete(this)
    report('request', { method: info.method, url: info.url, body: info.body, status: this.status, durationMs: Date.now() - info.started })
  })
  return 'installed'
})()`
