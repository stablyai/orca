// ---------------------------------------------------------------------------
// Browser action recorder — pure helpers (no electron, no bridge)
// ---------------------------------------------------------------------------

import {
  BROWSER_RECORDER_BUDGET,
  type BrowserRecorderAutomationParam,
  type BrowserRecorderAutomationTarget,
  type BrowserRecorderDomChangeKind,
  type BrowserRecorderDomDiff,
  type BrowserRecorderDomFingerprint
} from '../../shared/browser-recorder-automation'

// Why: a compact in-page snapshot is far cheaper than a full AX snapshot and
// still answers "did url/title/text/form state change" for every action.
export const DOM_FINGERPRINT_EXPRESSION = `(() => {
  try {
    const form = Array.from(document.querySelectorAll('input:not([type="password"]),textarea,select'))
    const inputs = form.slice(0, 50).map(function (el) {
      var v = (el && 'value' in el ? el.value : '') || ''
      var label = el.id || el.name || el.getAttribute('aria-label') || el.type || el.tagName
      return label + '=' + (v.length > 60 ? v.slice(0, 60) + '...' : v)
    }).join('|')
    var text = (document.body && document.body.innerText) || ''
    return {
      url: location.href,
      title: document.title,
      textLength: text.length,
      interactive: document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"]').length,
      inputs: inputs
    }
  } catch (e) {
    return { url: '', title: '', textLength: 0, interactive: 0, inputs: '' }
  }
})()`

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
  const inputsChanged = before.inputs !== after.inputs
  if (inputsChanged) {
    changed.push('inputs')
  }
  return {
    urlChanged,
    titleChanged,
    textLengthDelta,
    interactiveDelta,
    inputsChanged,
    changed
  }
}
