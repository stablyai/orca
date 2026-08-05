// ---------------------------------------------------------------------------
// Browser action recorder — in-page interaction capture preamble
//
// First half of INTERACTION_CAPTURE_EXPRESSION: the interaction listeners
// (typing burst coalescing, trusted clicks, hover, scroll) plus their element
// helpers. The network half lives in browser-interaction-capture-network.ts;
// browser-page-capture-expressions.ts concatenates both halves so the injected
// script stays one IIFE. Split purely to stay under the max-lines gate.
// ---------------------------------------------------------------------------

export const INTERACTION_CAPTURE_PREAMBLE = `(() => {
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
  function isPasswordField(el) {
    if (!el) { return false }
    if (el.type === 'password') { return true }
    var name = String(el.name || el.id || '')
    return /password|passwd|sifre|parola/i.test(name)
  }
  function elementInfo(el) {
    if (!el || !el.tagName) { return null }
    var classes = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 5) : []
    // Why: collapse newlines so element text never splits a log line. Never
    // leak a password field's value — mask it the same way typing does.
    var rawText = (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim()
    var text = isPasswordField(el) ? '••••••' : rawText.slice(0, 60)
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
  // ── text selection ──
  // Why: selecting text in the page is a user intent (copy, search, compare)
  // that we currently miss — capture the selection on mouseup when the user
  // lifted the button after a drag selection.
  document.addEventListener('mouseup', function (e) {
    if (!e.isTrusted) { return }
    try {
      var sel = document.getSelection()
      if (!sel || sel.isCollapsed) { return }
      var text = String(sel).replace(/\\s+/g, ' ').trim().slice(0, 200)
      if (text.length === 0) { return }
      var node = sel.anchorNode
      if (node && node.parentElement && isPasswordField(node.parentElement)) { return }
      report('select_text', { selectText: text })
    } catch (err) {}
  })
  // ── hover (dwell-based: only when the pointer stays put) ──
  // Why: moving the mouse across a page would otherwise log every element it
  // crosses; a hover should mean the pointer paused on the element.
  var lastHover = { target: '', at: 0 }
  var hoverTimer = null
  var hoverTarget = ''
  var hoverEl = null
  var HOVER_DWELL_MS = 450
  function cancelHover() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null }
    hoverTarget = ''
    hoverEl = null
    // Why: without this, re-hovering the same element after leaving it would
    // be swallowed (lastHover.target still equals the reported target).
    lastHover = { target: '', at: 0 }
  }
  function hoverTimerFired() {
    hoverTimer = null
    // Why: mouseout cancels the pending hover, so reaching this timer means
    // the pointer never left — report the element it paused on.
    if (hoverTarget && hoverTarget !== lastHover.target) {
      lastHover = { target: hoverTarget, at: Date.now() }
      report('hover', { target: hoverTarget, tagName: hoverEl && hoverEl.tagName ? hoverEl.tagName.toLowerCase() : '', el: elementInfo(hoverEl) })
    }
  }
  document.addEventListener('mouseover', function (e) {
    if (!e.isTrusted) { return }
    var target = summarize(e.target)
    if (target === hoverTarget) { return }
    if (hoverTimer) { clearTimeout(hoverTimer) }
    hoverTarget = target
    hoverEl = e.target
    hoverTimer = setTimeout(hoverTimerFired, HOVER_DWELL_MS)
  }, true)
  document.addEventListener('mouseout', function (e) {
    // Why: leaving the element cancels the pending hover; entering a child
    // still counts as staying (relatedTarget inside the element tree).
    if (hoverEl && e.target === hoverEl) {
      if (e.relatedTarget && hoverEl.contains && hoverEl.contains(e.relatedTarget)) {
        return
      }
      cancelHover()
    }
  }, true)
  // ── scroll (throttled, change-only, trailing emit) ──
  var lastScroll = null
  var lastScrollAt = 0
  var scrollTimer = null
  window.addEventListener('scroll', function () {
    var x = Math.round(window.scrollX)
    var y = Math.round(window.scrollY)
    var now = Date.now()
    // Why: only meaningful position changes are recorded — wheel events that
    // move nothing would otherwise log scroll x=0, y=0 noise.
    if (lastScroll && lastScroll.x === x && lastScroll.y === y) { return }
    if (scrollTimer) { clearTimeout(scrollTimer) }
    if (now - lastScrollAt >= 1000) {
      lastScroll = { x: x, y: y }
      lastScrollAt = now
      report('scroll', { x: x, y: y })
    } else {
      // Why: a short gesture would otherwise record only its first position —
      // the trailing timer emits the final coordinates when the throttle
      // window ends, so the log shows where the scroll actually stopped.
      scrollTimer = setTimeout(function () {
        scrollTimer = null
        lastScroll = { x: x, y: y }
        lastScrollAt = Date.now()
        report('scroll', { x: x, y: y })
      }, 1000 - (now - lastScrollAt))
    }
  }, true)
  // ── change (select/checkbox/input real value) ──
  // Why: a click on a <select> shows the option label but not what the app
  // actually read (value="2" vs label "İçerir") — capture the DOM value the
  // app's onchange handler received, redacting password fields.
  document.addEventListener('change', function (e) {
    if (!e.isTrusted) { return }
    var t = e.target
    if (!t || !t.tagName) { return }
    var tag = t.tagName.toLowerCase()
    if (tag !== 'select' && tag !== 'input' && tag !== 'textarea') { return }
    var raw = t.type === 'checkbox' || t.type === 'radio'
      ? (t.checked ? 'checked' : 'unchecked')
      : String(t.value || '')
    // Why: value may be large (textarea) — keep it tight for the log line.
    var value = isPasswordField(t) ? '••••••' : raw.replace(/\\s+/g, ' ').trim().slice(0, 200)
    report('change', { target: summarize(t), tagName: tag, value: value, el: elementInfo(t) })
  }, true)
  // ── clipboard (copy/paste/cut content) ──
  // Why: Webticari workflows rely on copy-paste (fatura line transfers);
  // keys alone (key Control+C) don't say what data moved. paste/cut read
  // clipboardData synchronously; copy falls back to the current selection.
  // Why: copy reads the selection, so copying out of a password field would
  // leak the real value; paste into one would leak whatever secret the user
  // moves. Mask both directions — the event still logs as "something moved".
  function clipTextFromEvent(e) {
    try {
      if (e.clipboardData && e.clipboardData.getData) {
        var d = e.clipboardData.getData('text')
        if (d && d.length > 0) { return d }
      }
    } catch (err) {}
    try {
      var sel = document.getSelection()
      return sel ? String(sel) : ''
    } catch (err) { return '' }
  }
  function maskedClipboardText(e, text) {
    if (isPasswordField(e.target) || isPasswordField(document.activeElement)) {
      return '••••••'
    }
    return text
  }
  document.addEventListener('copy', function (e) {
    if (!e.isTrusted) { return }
    var text = maskedClipboardText(e, clipTextFromEvent(e).replace(/\\s+/g, ' ').trim().slice(0, 200))
    if (text.length > 0) {
      report('clipboard', { clipboardAction: 'copy', clipboardText: text, target: summarize(e.target), el: elementInfo(e.target) })
    }
  }, true)
  document.addEventListener('cut', function (e) {
    if (!e.isTrusted) { return }
    var text = maskedClipboardText(e, clipTextFromEvent(e).replace(/\\s+/g, ' ').trim().slice(0, 200))
    if (text.length > 0) {
      report('clipboard', { clipboardAction: 'cut', clipboardText: text, target: summarize(e.target), el: elementInfo(e.target) })
    }
  }, true)
  document.addEventListener('paste', function (e) {
    if (!e.isTrusted) { return }
    var text = maskedClipboardText(e, clipTextFromEvent(e).replace(/\\s+/g, ' ').trim().slice(0, 200))
    if (text.length > 0) {
      report('clipboard', { clipboardAction: 'paste', clipboardText: text, target: summarize(e.target), el: elementInfo(e.target) })
    }
  }, true)
`
