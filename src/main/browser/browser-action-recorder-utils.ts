// ---------------------------------------------------------------------------
// Browser action recorder — pure helpers (no electron, no bridge)
// ---------------------------------------------------------------------------

import {
  BROWSER_RECORDER_BUDGET,
  BROWSER_RECORDER_INTERACTION_TAG,
  type BrowserRecorderAutomationParam,
  type BrowserRecorderAutomationTarget,
  type BrowserRecorderDomChangeKind,
  type BrowserRecorderDomDiff,
  type BrowserRecorderDomFingerprint,
  type BrowserRecorderInputChange,
  type BrowserRecorderInputState,
  type BrowserRecorderInteractionKind,
  type BrowserRecorderNetworkStatusBucket
} from '../../shared/browser-recorder-automation'
import type { BrowserNetworkEntry } from '../../shared/runtime-types'

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

// Why: while recording, manual page interactions are reported to the main
// process as tagged console.debug lines (the recorder's console-message
// listener splits tagged lines into interactions, everything else into console
// entries). One-shot: re-inject after a navigation to keep capturing.
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
    return el.tagName.toLowerCase()
  }
  document.addEventListener('click', function (e) {
    var t = e.target
    report('click', { x: e.clientX, y: e.clientY, target: summarize(t), tagName: t && t.tagName ? t.tagName.toLowerCase() : '' })
  }, true)
  document.addEventListener('keydown', function (e) {
    report('keydown', { key: String(e.key), code: e.code || '' })
  }, true)
  var lastScroll = 0
  document.addEventListener('scroll', function () {
    var now = Date.now()
    if (now - lastScroll < 1000) { return }
    lastScroll = now
    report('scroll', { x: Math.round(window.scrollX || 0), y: Math.round(window.scrollY || 0) })
  }, true)
  return 'installed'
})()`

/** Raw payload carried inside a tagged console.debug line from the page. */
export type BrowserRecorderInteractionPayload = {
  type: BrowserRecorderInteractionKind
  x?: number
  y?: number
  target?: string
  tagName?: string
  key?: string
  code?: string
}

/**
 * Parses a page console line into an interaction payload, or null when the
 * line is not a tagged interaction (regular console output).
 */
export function parseBrowserInteractionMessage(
  message: string
): BrowserRecorderInteractionPayload | null {
  if (!message.startsWith(BROWSER_RECORDER_INTERACTION_TAG)) {
    return null
  }
  const json = message.slice(BROWSER_RECORDER_INTERACTION_TAG.length).trim()
  try {
    const parsed = JSON.parse(json) as Partial<BrowserRecorderInteractionPayload>
    if (parsed.type !== 'click' && parsed.type !== 'keydown' && parsed.type !== 'scroll') {
      return null
    }
    return {
      type: parsed.type,
      x: typeof parsed.x === 'number' ? Math.round(parsed.x) : undefined,
      y: typeof parsed.y === 'number' ? Math.round(parsed.y) : undefined,
      target: typeof parsed.target === 'string' ? parsed.target.slice(0, 100) : undefined,
      tagName: typeof parsed.tagName === 'string' ? parsed.tagName.slice(0, 40) : undefined,
      key: typeof parsed.key === 'string' ? parsed.key.slice(0, 40) : undefined,
      code: typeof parsed.code === 'string' ? parsed.code.slice(0, 40) : undefined
    }
  } catch {
    return null
  }
}

/** Summarizes a page network log into the compact recorder report. */
export function summarizeBrowserNetworkEntries(entries: BrowserNetworkEntry[]): {
  total: number
  failed: number
  totalBytes: number
  byStatus: BrowserRecorderNetworkStatusBucket[]
} {
  const byStatus = new Map<number, number>()
  let failed = 0
  let totalBytes = 0
  for (const entry of entries) {
    const status = typeof entry.status === 'number' ? entry.status : 0
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1)
    if (status >= 400) {
      failed += 1
    }
    if (typeof entry.size === 'number' && entry.size > 0) {
      totalBytes += entry.size
    }
  }
  const buckets = [...byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([status, count]) => ({ status, count }))
  return { total: entries.length, failed, totalBytes, byStatus: buckets }
}

// Why: only interactive/mutating actions are worth logging; read-only probes
// (snapshot/screenshot/get/is/find/console/network) and account plumbing
// (profile/cookie/storage/clipboard) are noise or secret-bearing.
const RECORDED_METHODS = new Set([
  'browser.click',
  'browser.dblclick',
  'browser.hover',
  'browser.drag',
  'browser.goto',
  'browser.back',
  'browser.forward',
  'browser.reload',
  'browser.fill',
  'browser.type',
  'browser.keyboardInsertText',
  'browser.select',
  'browser.scroll',
  'browser.scrollIntoView',
  'browser.keypress',
  'browser.check',
  'browser.focus',
  'browser.clear',
  'browser.selectAll',
  'browser.upload',
  'browser.wait',
  'browser.mouseMove',
  'browser.mouseDown',
  'browser.mouseClick',
  'browser.mouseUp',
  'browser.mouseWheel',
  'browser.tabSwitch'
])

// Why: these actions can replace the page (and its capture script), so the
// session observer re-attaches its listener and script after them.
export const NAVIGATION_METHODS = new Set([
  'browser.goto',
  'browser.back',
  'browser.forward',
  'browser.reload'
])

// Why: these methods carry credential-shaped payloads; log the fact, not the data.
const FULLY_REDACTED_METHODS = new Set([
  'browser.clipboardWrite',
  'browser.setCredentials',
  'browser.setHeaders',
  'browser.cookie.set',
  'browser.storage.local.set',
  'browser.storage.session.set'
])

const SECRET_PARAM_PATTERN =
  /password|passwd|secret|token|authorization|api[_-]?key|credential|csrf/i

export function isRecordedBrowserMethod(method: string): boolean {
  return RECORDED_METHODS.has(method)
}

export function isFullyRedactedBrowserMethod(method: string): boolean {
  return FULLY_REDACTED_METHODS.has(method)
}

export function capText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}

export function sanitizeBrowserActionParams(
  method: string,
  params: Record<string, unknown>
): Record<string, BrowserRecorderAutomationParam> {
  if (isFullyRedactedBrowserMethod(method)) {
    return { redacted: true }
  }
  const out: Record<string, BrowserRecorderAutomationParam> = {}
  for (const [key, value] of Object.entries(params)) {
    // Why: worktree/page are routing selectors, not action parameters.
    if (key === 'worktree' || key === 'page') {
      continue
    }
    if (SECRET_PARAM_PATTERN.test(key)) {
      continue
    }
    if (typeof value === 'string') {
      out[key] = capText(value, BROWSER_RECORDER_BUDGET.paramValueMaxLength)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    } else if (Array.isArray(value)) {
      const items = value
        .filter((entry) => typeof entry === 'string' || typeof entry === 'number')
        .slice(0, 5)
        .map(String)
      if (items.length > 0) {
        out[key] = capText(items.join(', '), BROWSER_RECORDER_BUDGET.paramValueMaxLength)
      }
    }
  }
  return out
}

export function extractBrowserActionTarget(
  params: Record<string, unknown>
): BrowserRecorderAutomationTarget {
  if (typeof params.element === 'string' && params.element.length > 0) {
    const value = params.element
    return { kind: value.startsWith('@') ? 'ref' : 'selector', value }
  }
  if (typeof params.from === 'string' && typeof params.to === 'string') {
    return { kind: 'selector', value: `${params.from} → ${params.to}` }
  }
  if (typeof params.url === 'string' && params.url.length > 0) {
    return { kind: 'url', value: params.url }
  }
  if (typeof params.x === 'number' && typeof params.y === 'number') {
    return { kind: 'coordinate', value: `${Math.round(params.x)},${Math.round(params.y)}` }
  }
  if (typeof params.selector === 'string' && params.selector.length > 0) {
    return { kind: 'selector', value: params.selector }
  }
  if (typeof params.key === 'string' && params.key.length > 0) {
    return { kind: 'none', value: `key:${params.key}` }
  }
  return { kind: 'none', value: '' }
}

export function diffFingerprints(
  before: BrowserRecorderDomFingerprint,
  after: BrowserRecorderDomFingerprint
): BrowserRecorderDomDiff {
  const changed: BrowserRecorderDomChangeKind[] = []
  const urlChanged = before.url !== after.url
  if (urlChanged) {
    changed.push('url')
  }
  const titleChanged = before.title !== after.title
  if (titleChanged) {
    changed.push('title')
  }
  const textLengthDelta = after.textLength - before.textLength
  if (textLengthDelta !== 0) {
    changed.push('text')
  }
  const interactiveDelta = after.interactive - before.interactive
  if (interactiveDelta !== 0) {
    changed.push('interactive')
  }
  const inputChanges = diffInputStates(before.inputsDetail, after.inputsDetail)
  const inputsChanged = inputChanges.length > 0
  if (inputsChanged) {
    changed.push('inputs')
  }
  return {
    urlChanged,
    titleChanged,
    textLengthDelta,
    interactiveDelta,
    inputsChanged,
    inputChanges,
    changed
  }
}

function diffInputStates(
  before: BrowserRecorderInputState[],
  after: BrowserRecorderInputState[]
): BrowserRecorderInputChange[] {
  const beforeByLabel = new Map(before.map((state) => [state.label, state.value]))
  const changes: BrowserRecorderInputChange[] = []
  for (const field of after) {
    const prev = beforeByLabel.get(field.label)
    if (prev !== undefined && prev !== field.value) {
      changes.push({ label: field.label, before: prev, after: field.value })
    }
    beforeByLabel.delete(field.label)
  }
  // Why: a field present before but gone after means the page replaced the
  // form (navigation or re-render); surface it as cleared rather than silent.
  for (const [label, value] of beforeByLabel) {
    changes.push({ label, before: value, after: '' })
  }
  return changes.slice(0, BROWSER_RECORDER_BUDGET.inputChangesMaxEntries)
}
