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
  function cssPath(el) {
    if (!el || !el.tagName) { return '' }
    if (el.id) { return el.tagName.toLowerCase() + '#' + el.id }
    var parts = []
    var node = el
    while (node && node.tagName && node !== document.body && node !== document.documentElement) {
      var part = node.tagName.toLowerCase()
      if (node.id) { part += '#' + node.id; parts.unshift(part); break }
      if (typeof node.className === 'string' && node.className.trim()) {
        part += '.' + node.className.trim().split(/\\s+/).slice(0, 3).join('.')
      }
      var parent = node.parentElement
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (s) { return s.tagName === node.tagName })
        if (siblings.length > 1) { part += ':nth-of-type(' + (Array.prototype.indexOf.call(siblings, node) + 1) + ')' }
      }
      parts.unshift(part)
      node = parent
    }
    if (node === document.body) { parts.unshift('body') }
    return parts.join(' > ')
  }
  function elementInfo(el) {
    if (!el || !el.tagName) { return null }
    var classes = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 5) : []
    // Why: collapse newlines so element text never splits a log line.
    var text = (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 60)
    var styles = []
    try {
      var cs = window.getComputedStyle(el)
      if (cs.display === 'none') { styles.push('display:none') }
      if (cs.visibility === 'hidden') { styles.push('visibility:hidden') }
      if (cs.position === 'fixed' || cs.position === 'absolute') { styles.push('position:' + cs.position) }
      if (cs.pointerEvents === 'none') { styles.push('pointer-events:none') }
    } catch (e) {}
    return {
      selector: cssPath(el),
      tagName: el.tagName.toLowerCase(),
      classes: classes,
      text: text,
      styles: styles
    }
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
  var typing = { text: '', target: '', element: null, lastAt: 0, timer: null }
  var TYPE_PAUSE_MS = 450
  function flushTyping() {
    if (typing.timer) { clearTimeout(typing.timer); typing.timer = null }
    if (typing.text.length > 0) {
      report('type', { text: typing.text, target: typing.target, el: typing.element })
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
    if (!e.isTrusted) { flushTyping(); return }
    var active = document.activeElement
    var target = summarize(active)
    if (isPrintableKey(e.key)) {
      // Why: never leak typed password content into the recording log; keep
      // the marker length so the burst still reads as "something typed here".
      if (isPasswordField(active)) {
        typing.text += '•'
      } else {
        typing.text += e.key
      }
      typing.target = target
      typing.element = elementInfo(active)
      typing.lastAt = Date.now()
      scheduleFlush()
      return
    }
    flushTyping()
    if (e.key && e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') {
      report('keydown', { key: e.key, target: target, el: elementInfo(active) })
    }
  }, true)
  document.addEventListener('click', function (e) {
    flushTyping()
    // Why: synthetic .click() calls (app-internal triggers) are not user
    // actions — log only trusted clicks so the flow stays truthful.
    if (!e.isTrusted) { return }
    var t = e.target
    report('click', { x: e.clientX, y: e.clientY, target: summarize(t), tagName: t && t.tagName ? t.tagName.toLowerCase() : '', el: elementInfo(t) })
  }, true)
  // ── hover (element change, throttled) ──
  var lastHover = { target: '', at: 0 }
  document.addEventListener('mouseover', function (e) {
    var now = Date.now()
    if (now - lastHover.at < 300) { return }
    var target = summarize(e.target)
    if (target === lastHover.target) { return }
    lastHover = { target: target, at: now }
    report('hover', { target: target, tagName: e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '', el: elementInfo(e.target) })
  }, true)
  // ── scroll (throttled, change-only) ──
  var lastScroll = null
  var lastScrollAt = 0
  window.addEventListener('scroll', function () {
    var x = Math.round(window.scrollX)
    var y = Math.round(window.scrollY)
    var now = Date.now()
    // Why: only meaningful position changes are recorded — wheel events that
    // move nothing would otherwise log scroll x=0, y=0 noise.
    if (lastScroll && lastScroll.x === x && lastScroll.y === y) { return }
    if (now - lastScrollAt < 1000) { return }
    lastScroll = { x: x, y: y }
    lastScrollAt = now
    report('scroll', { x: x, y: y })
  }, true)
  function originStack() {
    try { return new Error().stack || '' } catch (e) { return '' }
  }
  // ── network requests (fetch + XHR, report on completion) ──
  var nativeFetch = window.fetch
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || ''
      var method = (init && init.method) || (input && input.method) || 'GET'
      var body = init && init.body ? String(init.body) : ''
      var started = Date.now()
      var origin = originStack()
      return nativeFetch.apply(this, arguments).then(function (res) {
        report('request', { method: method, url: url, body: body, status: res.status, durationMs: Date.now() - started, origin: origin, kind: 'fetch' })
        return res
      }, function (err) {
        report('request', { method: method, url: url, body: body, status: -1, durationMs: Date.now() - started, origin: origin, kind: 'fetch' })
        throw err
      })
    }
  }
  var nativeOpen = XMLHttpRequest.prototype.open
  var nativeSend = XMLHttpRequest.prototype.send
  var pending = new WeakMap()
  XMLHttpRequest.prototype.open = function (method, url) {
    pending.set(this, { method: String(method), url: String(url), body: '', started: Date.now(), origin: originStack() })
    return nativeOpen.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function (body) {
    var info = pending.get(this)
    if (info) { info.body = body == null ? '' : String(body) }
    var xhr = this
    // Why: listeners must be registered on the instance — prototype-level
    // addEventListener never receives events dispatched on instances.
    if (!xhr.__orcaLoadendAttached) {
      xhr.__orcaLoadendAttached = true
      xhr.addEventListener('loadend', function () {
        var i = pending.get(xhr)
        if (!i) { return }
        pending.delete(xhr)
        report('request', { method: i.method, url: i.url, body: i.body, status: xhr.status, durationMs: Date.now() - i.started, origin: i.origin, kind: 'xhr' })
      })
    }
    return nativeSend.apply(this, arguments)
  }
  return 'installed'
})()`
