// ---------------------------------------------------------------------------
// Browser action recorder — in-page network capture (second half)
//
// Second half of INTERACTION_CAPTURE_EXPRESSION: the fetch/XHR hooks plus the
// response pipeline (head+tail truncation, HTML → text/controls schematizing).
// browser-page-capture-expressions.ts concatenates this with the interaction
// preamble so the injected script stays one IIFE. Split for max-lines.
// ---------------------------------------------------------------------------

export const INTERACTION_CAPTURE_NETWORK = `  function originStack() {
    try { return new Error().stack || '' } catch (e) { return '' }
  }
  // ── network requests (fetch + XHR, report on completion) ──
  // Why: response bodies are read opportunistically — the content-length
  // header short-circuits huge payloads before any clone/text read; otherwise
  // the text is read once, capped to the same budget as the main process.
  // The log is saved to a file, so the cap is generous (8KB) to keep enough
  // response context without ballooning the session log. Truncated responses
  // keep both ends (head + tail) — large HTML list pages have the data rows
  // at the tail, so cutting only the head would lose the actual content.
  var RESPONSE_MAX = 8000
  var RESPONSE_HEAD = 5800
  var RESPONSE_TAIL = RESPONSE_MAX - RESPONSE_HEAD
  // Why: large HTML list responses are exactly the ones we schematize, so the
  // content-length short-circuit only skips truly huge payloads (binary/media
  // downloads) — anything up to 2MB is read once and capped/schematized.
  var RESPONSE_READ_MAX = 2 * 1024 * 1024
  function truncateResponseText(t) {
    if (t.length <= RESPONSE_MAX) {
      return { text: t, size: t.length, truncated: false }
    }
    // Why: mark the omitted middle so the reader knows the gap; the marker is
    // ASCII-only so it survives any downstream encoding.
    var omitted = t.length - RESPONSE_HEAD - RESPONSE_TAIL
    return {
      text: t.slice(0, RESPONSE_HEAD) + '\\n…[' + omitted + ' chars omitted]…\\n' + t.slice(-RESPONSE_TAIL),
      size: t.length,
      truncated: true
    }
  }
  function isSecretField(el) {
    if (!el) { return false }
    if (el.type === 'password') { return true }
    var name = String(el.name || el.id || '')
    return /password|passwd|sifre|parola/i.test(name)
  }
  // Why: raw HTML responses are markup noise for an agent — instead of tags,
  // render a compact structure tree: each important element as
  // tag#id.class1.class2 with its inline event handlers
  // (input[onchange="Callback()"]), the visible table rows with cell
  // separators, and a grab-style control inventory. JSON is untouched.
  var EVENT_HANDLERS = ['onclick', 'onchange', 'onblur', 'onkeyup', 'onkeydown', 'oninput', 'onsubmit', 'onfocus', 'ondblclick', 'onmouseover']
  function summarizeElement(el) {
    var tag = el.tagName.toLowerCase()
    if (el.id) { tag += '#' + el.id }
    var classes = []
    if (typeof el.className === 'string') {
      classes = el.className.split(/\\s+/).filter(function (c) { return c.length > 0 }).slice(0, 3)
    }
    if (classes.length > 0) { tag += '.' + classes.join('.') }
    var handlers = []
    for (var hi = 0; hi < EVENT_HANDLERS.length; hi++) {
      var attr = el.getAttribute(EVENT_HANDLERS[hi])
      if (attr) { handlers.push(EVENT_HANDLERS[hi] + '="' + attr.replace(/\\s+/g, ' ').trim().slice(0, 60) + '"') }
    }
    if (handlers.length > 0) { tag += '[' + handlers.join(' ') + ']' }
    return tag
  }
  function schematizeResponseText(t) {
    if (t.length === 0 || t.trim().charAt(0) !== '<') { return null }
    try {
      var doc = new DOMParser().parseFromString(t, 'text/html')
      var out = []
      // ── structure tree: the meaningful containers, as a chain ──
      // Why: "what lives where" matters more than the full markup — id'd
      // sections, forms, and tables form a readable spine of the response.
      var spine = []
      var cursor = doc.body
      var depth = 0
      while (cursor && cursor.tagName && depth < 6) {
        var important = cursor.id || cursor.tagName === 'TABLE' || cursor.tagName === 'FORM'
        if (important && cursor !== doc.body) { spine.push(summarizeElement(cursor)) }
        var next = null
        var kids = cursor.children ? Array.prototype.slice.call(cursor.children) : []
        for (var ki = 0; ki < kids.length; ki++) {
          if (kids[ki].id || kids[ki].tagName === 'TABLE' || kids[ki].tagName === 'FORM') { next = kids[ki]; break }
        }
        if (!next && cursor.tagName === 'TABLE' && cursor.tBodies && cursor.tBodies.length > 0) {
          next = cursor.tBodies[0]
        }
        if (!next) { break }
        cursor = next
        depth += 1
      }
      if (spine.length > 0) { out.push('yapı: ' + spine.join(' > ')) }
      // ── content: tables row-by-row, then the remaining visible text ──
      // Why: innerText's cell separators differ across engines (tab vs
      // nothing), so read tables straight from the DOM: each row becomes
      // 'cell | cell', rows join with ' || ' — data stays readable on the
      // single-line log. Non-table text is appended as plain lines.
      var textParts = []
      // Why: tables carry the report data — give them the budget first
      // (up to 20 rows), then fill remaining space with plain body lines.
      var tables = doc.querySelectorAll('table')
      for (var ti = 0; ti < tables.length && textParts.length < 20; ti++) {
        var rows = tables[ti].querySelectorAll('tr')
        for (var ri = 0; ri < rows.length && textParts.length < 20; ri++) {
          var cells = []
          var cellEls = rows[ri].querySelectorAll('th, td')
          for (var di = 0; di < cellEls.length; di++) {
            var cellText = (cellEls[di].innerText || cellEls[di].textContent || '').replace(/\\s+/g, ' ').trim()
            if (cellText.length > 0) { cells.push(cellText) }
          }
          if (cells.length > 0) { textParts.push(cells.join(' | ')) }
        }
      }
      var bodyText = (doc.body && doc.body.innerText) || ''
      var bodyLines = bodyText.split('\\n')
      for (var bi = 0; bi < bodyLines.length && textParts.length < 20; bi++) {
        var bodyLine = bodyLines[bi].replace(/\\s+/g, ' ').trim()
        if (bodyLine.length === 0) { continue }
        // Why: table rows already captured above reappear as flat innerText
        // lines (engine-dependent separators) — drop near-duplicates by
        // comparing with all whitespace stripped from both sides.
        var flat = bodyLine.replace(/\\s+/g, '')
        var dup = false
        for (var pi = 0; pi < textParts.length; pi++) {
          if (textParts[pi].replace(/\\s+/g, '') === flat) { dup = true; break }
        }
        if (!dup) { textParts.push(bodyLine) }
      }
      if (textParts.length > 0) { out.push('içerik: ' + textParts.join(' || ')) }
      // Why: script-only responses (stok counters, bildirim codes) have empty
      // body text but the payload is in script bodies — keep a slice.
      var scripts = doc.querySelectorAll('script')
      var scriptLines = []
      for (var si = 0; si < scripts.length && scriptLines.length < 30; si++) {
        var code = (scripts[si].textContent || '').replace(/\\s+/g, ' ').trim()
        if (code.length > 0) { scriptLines.push('[script] ' + code.slice(0, 300)) }
      }
      if (scriptLines.length > 0) { out.push('script: ' + scriptLines.join(' · ')) }
      // ── controls: interactive elements with handlers + values ──
      var controls = []
      var els = doc.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea')
      for (var ci = 0; ci < els.length && controls.length < 20; ci++) {
        var el = els[ci]
        var tag = summarizeElement(el)
        var label = ''
        if (el.tagName === 'BUTTON' || el.tagName === 'A') {
          label = (el.innerText || el.title || '').replace(/\\s+/g, ' ').trim().slice(0, 60)
        } else {
          label = (el.placeholder || el.name || el.id || el.tagName.toLowerCase()).slice(0, 40)
        }
        if (label) { tag += ' "' + label + '"' }
        if (!isSecretField(el)) {
          if ('value' in el && el.value) { tag += '=' + String(el.value).slice(0, 40) }
        }
        controls.push(tag)
      }
      if (controls.length > 0) { out.push('kontroller: ' + controls.join(' · ')) }
      var result = out.join(' | ')
      return result.length > 0 ? result : null
    } catch (e) {
      return null
    }
  }
  function processResponseText(t) {
    var schematized = schematizeResponseText(t)
    var kept = schematized || t
    var capped = truncateResponseText(kept)
    return {
      text: capped.text,
      // Why: report the original size — the schematized text is shorter but
      // the reader should know the real payload was large.
      size: t.length,
      truncated: capped.truncated,
      schema: schematized ? 'html' : 'text'
    }
  }
  function captureResponseText(res) {
    try {
      var cl = res.headers && res.headers.get ? Number(res.headers.get('content-length') || 0) : 0
      if (cl > RESPONSE_READ_MAX) {
        return Promise.resolve({ text: '', size: cl, truncated: true, schema: 'text' })
      }
      return res.clone().text().then(function (t) {
        return processResponseText(t)
      }, function () {
        return { text: '', size: 0, truncated: false, schema: 'text' }
      })
    } catch (e) {
      return Promise.resolve({ text: '', size: 0, truncated: false, schema: 'text' })
    }
  }
  function captureXhrResponse(xhr) {
    try {
      // Why: responseText is only populated for text responses; JSON/blob/
      // arraybuffer responses are skipped (binary/opaque, low context value).
      if (xhr.responseType && xhr.responseType !== 'text') {
        return { text: '', size: 0, truncated: false, schema: 'text' }
      }
      var t = typeof xhr.responseText === 'string' ? xhr.responseText : ''
      return processResponseText(t)
    } catch (e) {
      return { text: '', size: 0, truncated: false, schema: 'text' }
    }
  }
  var nativeFetch = window.fetch
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || ''
      var method = (init && init.method) || (input && input.method) || 'GET'
      var body = init && init.body ? String(init.body) : ''
      var started = Date.now()
      var origin = originStack()
      return nativeFetch.apply(this, arguments).then(function (res) {
        // Why: the response body read must never delay the app's fetch
        // promise — record in the background and hand res back unchanged.
        captureResponseText(res).then(function (resp) {
          report('request', { method: method, url: url, body: body, status: res.status, durationMs: Date.now() - started, origin: origin, kind: 'fetch', response: resp.text, responseSize: resp.size, responseTruncated: resp.truncated, responseSchema: resp.schema })
        }, function () {})
        return res
      }, function (err) {
        report('request', { method: method, url: url, body: body, status: -1, durationMs: Date.now() - started, origin: origin, kind: 'fetch', response: '', responseSize: 0, responseTruncated: false, responseSchema: 'text' })
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
        var resp = captureXhrResponse(xhr)
        report('request', { method: i.method, url: i.url, body: i.body, status: xhr.status, durationMs: Date.now() - i.started, origin: i.origin, kind: 'xhr', response: resp.text, responseSize: resp.size, responseTruncated: resp.truncated, responseSchema: resp.schema })
      })
    }
    return nativeSend.apply(this, arguments)
  }
  // ── WebSocket messages ──
  var NativeWebSocket = window.WebSocket
  if (typeof NativeWebSocket === 'function') {
    var WS_PATCHED = '__orcaWsPatched'
    window.WebSocket = function (url, protocols) {
      var ws = protocols ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url)
      if (!ws[WS_PATCHED]) {
        try { Object.defineProperty(ws, WS_PATCHED, { value: true }) } catch (e) { ws[WS_PATCHED] = true }
        ws.addEventListener('message', function (ev) {
          try {
            var data = typeof ev.data === 'string' ? ev.data : String(ev.data || '')
            if (data.length === 0) { return }  // keep-alive frames
            report('ws', { text: data.replace(/\\s+/g, ' ').trim().slice(0, 200) })
          } catch (err) {}
        })
      }
      return ws
    }
    window.WebSocket.prototype = NativeWebSocket.prototype
    // Keep static constants working (CONNECTING/OPEN/CLOSING/CLOSED).
    window.WebSocket.CONNECTING = NativeWebSocket.CONNECTING
    window.WebSocket.OPEN = NativeWebSocket.OPEN; window.WebSocket.CLOSING = NativeWebSocket.CLOSING
    window.WebSocket.CLOSED = NativeWebSocket.CLOSED
  }
  // ── localStorage/sessionStorage writes ──
  var nativeSetItem = window.Storage && window.Storage.prototype.setItem
  if (typeof nativeSetItem === 'function') {
    var lastStorage = { key: '', value: '', at: 0 }
    var STORAGE_THROTTLE_MS = 2000
    window.Storage.prototype.setItem = function (key, value) {
      try {
        var k = String(key || '').slice(0, 80)
        var v = String(value == null ? '' : value).replace(/\\s+/g, ' ').trim().slice(0, 200)
        if (k.length === 0 || v.length === 0) { return nativeSetItem.apply(this, arguments) }  // empty write
        if (/password|passwd|sifre|parola|token|key/i.test(k)) { v = '••••••' }
        var now = Date.now()
        if (k === lastStorage.key && v === lastStorage.value && now - lastStorage.at < STORAGE_THROTTLE_MS) {
          return nativeSetItem.apply(this, arguments)  // debounce
        }
        lastStorage = { key: k, value: v, at: now }
        report('storage', { key: k, value: v })
      } catch (err) {}
      return nativeSetItem.apply(this, arguments)
    }
  }
  return 'installed'
})()`
