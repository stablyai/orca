// ---------------------------------------------------------------------------
// Browser action recorder — pure helpers (no electron, no bridge)
//
// Method classification, param sanitization, target extraction, fingerprint
// diffing, and network-log summarization. In-page capture expressions live in
// browser-page-capture-expressions.ts; tagged-line parsing in
// browser-recorder-message-parsing.ts.
// ---------------------------------------------------------------------------

import {
  BROWSER_RECORDER_BUDGET,
  type BrowserRecorderAutomationParam,
  type BrowserRecorderAutomationTarget,
  type BrowserRecorderDomChangeKind,
  type BrowserRecorderDomDiff,
  type BrowserRecorderDomFingerprint,
  type BrowserRecorderInputChange,
  type BrowserRecorderInputState,
  type BrowserRecorderNetworkStatusBucket
} from '../../shared/browser-recorder-automation'
import type { BrowserNetworkEntry } from '../../shared/runtime-types'

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

// Why: text-entry payloads carry user-typed values under neutral keys
// ('value'/'input'/'text'). browser.fill's element selector is checked for
// password hints; browser.type/keyboardInsertText type into the focused field
// with no selector, so their payloads are masked unconditionally.
const TEXT_ENTRY_METHODS = new Set(['browser.fill', 'browser.type', 'browser.keyboardInsertText'])

const TEXT_ENTRY_PAYLOAD_KEY: Record<string, string> = {
  'browser.fill': 'value',
  'browser.type': 'input',
  'browser.keyboardInsertText': 'text'
}

const PASSWORD_FIELD_HINT =
  /password|passwd|pwd|secret|token|credential|sifre|parola|type=.?["']?password/i

// Why: mirrors the in-page isPasswordField heuristic (el.type === 'password'
// or name/id matching) against the only text-entry target we can see.
function passwordHinted(params: Record<string, unknown>): boolean {
  const element = typeof params.element === 'string' ? params.element : ''
  return PASSWORD_FIELD_HINT.test(element)
}

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
    const payloadKey = TEXT_ENTRY_METHODS.has(method) ? TEXT_ENTRY_PAYLOAD_KEY[method] : undefined
    if (
      payloadKey !== undefined &&
      key === payloadKey &&
      typeof value === 'string' &&
      value.length > 0
    ) {
      // Why: mask credential-shaped text payloads — the value param of a fill
      // on a password field, and the (selector-less) type/insert payloads.
      if (method !== 'browser.fill' || passwordHinted(params)) {
        out[key] = '••••••'
        continue
      }
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
  const textChange = diffBodyText(before.bodyText, after.bodyText)
  // Why: both the length delta and the text snippet describe the same change
  // kind — report 'text' once so the compact log does not show duplicates.
  if (textLengthDelta !== 0 || textChange) {
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
    textChange,
    changed
  }
}

/**
 * Lifts the changed region of the visible body text out of the full
 * before/after snapshots: trims the common prefix/suffix, then caps each side
 * to the log budget so a tiny edit in a large page stays readable. Returns
 * null when both snapshots are absent, equal, or the trimmed region is empty.
 */
function diffBodyText(
  before: string | undefined,
  after: string | undefined
): { before: string; after: string } | null {
  if (!before || !after || before === after) {
    return null
  }
  let start = 0
  const maxStart = Math.min(before.length, after.length)
  while (start < maxStart && before[start] === after[start]) {
    start += 1
  }
  let beforeEnd = before.length
  let afterEnd = after.length
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1
    afterEnd -= 1
  }
  const beforeSnippet = before.slice(start, beforeEnd)
  const afterSnippet = after.slice(start, afterEnd)
  if (beforeSnippet.length === 0 && afterSnippet.length === 0) {
    return null
  }
  const max = BROWSER_RECORDER_BUDGET.textChangeMaxLength
  return {
    before: capText(beforeSnippet, max),
    after: capText(afterSnippet, max)
  }
}

function diffInputStates(
  before: BrowserRecorderInputState[],
  after: BrowserRecorderInputState[]
): BrowserRecorderInputChange[] {
  // Why: key (not label) is the identity — unnamed fields share the label
  // 'text', so a label-keyed map would merge two distinct inputs.
  const beforeByKey = new Map(before.map((state) => [state.key, state]))
  const changes: BrowserRecorderInputChange[] = []
  for (const field of after) {
    const prev = beforeByKey.get(field.key)
    if (prev !== undefined && prev.value !== field.value) {
      changes.push({ key: field.key, label: field.label, before: prev.value, after: field.value })
    }
    beforeByKey.delete(field.key)
  }
  // Why: a field present before but gone after means the page replaced the
  // form (navigation or re-render); surface it as cleared rather than silent.
  for (const [, state] of beforeByKey) {
    changes.push({ key: state.key, label: state.label, before: state.value, after: '' })
  }
  return changes.slice(0, BROWSER_RECORDER_BUDGET.inputChangesMaxEntries)
}

/** Parses the fingerprint expression's raw inputsDetail payload into states. */
export function parseInputsDetail(value: unknown): BrowserRecorderInputState[] {
  if (!Array.isArray(value)) {
    return []
  }
  const states: BrowserRecorderInputState[] = []
  for (const field of value) {
    if (!field || typeof field !== 'object') {
      continue
    }
    const label = (field as Record<string, unknown>).label
    const fieldValue = (field as Record<string, unknown>).value
    const fieldKey = (field as Record<string, unknown>).key
    if (typeof label !== 'string') {
      continue
    }
    states.push({
      key:
        typeof fieldKey === 'string'
          ? fieldKey.slice(0, BROWSER_RECORDER_BUDGET.paramValueMaxLength)
          : label.slice(0, BROWSER_RECORDER_BUDGET.paramValueMaxLength),
      label: label.slice(0, BROWSER_RECORDER_BUDGET.paramValueMaxLength),
      value:
        typeof fieldValue === 'string'
          ? fieldValue.slice(0, BROWSER_RECORDER_BUDGET.inputValueMaxLength)
          : ''
    })
    if (states.length >= BROWSER_RECORDER_BUDGET.fingerprintInputsMaxFields) {
      break
    }
  }
  return states
}
