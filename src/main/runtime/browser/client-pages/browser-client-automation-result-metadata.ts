import { isRecord } from '../../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import { redactKagiSessionToken } from '../../../../shared/browser/navigation/browser-url'
import type { BrowserClientAutomationMethod } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import { redactBrowserMetadataGetter } from '../../../../shared/browser/browser-metadata-redaction'

const PAGE_RECEIPTS = new Set<BrowserClientAutomationMethod>([
  'browser.snapshot',
  'browser.goto',
  'browser.back',
  'browser.forward',
  'browser.reload',
  'browser.certificate.proceed'
])
const ACTION_RECEIPTS = new Set<BrowserClientAutomationMethod>([
  'browser.click',
  'browser.dblclick',
  'browser.goto',
  'browser.back',
  'browser.forward',
  'browser.reload',
  'browser.certificate.proceed',
  'browser.fill',
  'browser.type',
  'browser.keyboardInsertText',
  'browser.select',
  'browser.scroll',
  'browser.hover',
  'browser.drag',
  'browser.upload',
  'browser.check',
  'browser.focus',
  'browser.clear',
  'browser.selectAll',
  'browser.keypress',
  'browser.mouseMove',
  'browser.mouseDown',
  'browser.mouseClick',
  'browser.mouseUp',
  'browser.mouseWheel',
  'browser.scrollIntoView',
  'browser.find'
])

function redactFields(value: Record<string, unknown>, fields: readonly string[]) {
  let safe = value
  for (const field of fields) {
    const raw = value[field]
    if (typeof raw !== 'string') {
      continue
    }
    const redacted = redactKagiSessionToken(raw)
    if (redacted !== raw) {
      safe = { ...safe, [field]: redacted }
    }
  }
  return safe
}

function redactRows(value: Record<string, unknown>, field: string, urlField: string) {
  const rows = value[field]
  if (!Array.isArray(rows)) {
    return value
  }
  let changed = false
  const safe = rows.map((row: unknown) => {
    const redacted = isRecord(row) ? redactFields(row, [urlField]) : row
    changed ||= redacted !== row
    return redacted
  })
  return changed ? { ...value, [field]: safe } : value
}

function redactOrigin(value: Record<string, unknown>, field: string) {
  const raw = value[field]
  if (!isRecord(raw)) {
    return value
  }
  const safe = redactFields(raw, ['origin'])
  return safe === raw ? value : { ...value, [field]: safe }
}

export function redactClientBrowserAutomationResult(
  method: BrowserClientAutomationMethod,
  value: unknown,
  params?: unknown
): unknown {
  if (method === 'browser.get' && isRecord(params)) {
    value = redactBrowserMetadataGetter(params.what, value)
  }
  if (!isRecord(value)) {
    return value
  }
  let safe = redactFields(value, ['checkedUrl'])
  if (PAGE_RECEIPTS.has(method)) {
    safe = redactFields(safe, ['url', 'title'])
    safe = redactOrigin(safe, 'passkeyRequest')
  } else if (method === 'browser.eval') {
    safe = redactFields(safe, ['origin'])
  } else if (method === 'browser.upload') {
    safe = redactFields(safe, ['frameUrl'])
  } else if (method === 'browser.get') {
    safe = redactFields(safe, ['url', 'title'])
  }
  if (!ACTION_RECEIPTS.has(method) || !isRecord(value.effects)) {
    return safe
  }
  let effects = redactFields(value.effects, ['url', 'title'])
  effects = redactRows(effects, 'newTabs', 'url')
  effects = redactRows(effects, 'popups', 'origin')
  effects = redactRows(effects, 'downloads', 'origin')
  effects = redactOrigin(effects, 'blockedPrint')
  effects = redactOrigin(effects, 'passkeyRequest')
  return effects === value.effects ? safe : { ...safe, effects }
}
