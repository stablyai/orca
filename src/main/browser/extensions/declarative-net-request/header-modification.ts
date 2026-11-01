import { REQUEST_HEADER_APPEND_DELIMITERS, type DnrHeaderModification } from './header-rules'
import type { DnrRequestAction } from './ruleset-matcher'

// Applies modifyHeaders actions the way web_request_api_helpers.cc does
// (ModifyRequestHeadersForAction, ModifyResponseHeadersForAction, DNRHeaderAction).
// Actions arrive in precedence order; the first operation on a header decides what may follow:
// remove blocks everything, append allows only appends, set allows appends from its extension.

type FirstOperation = { operation: DnrHeaderModification['operation']; extensionId: string }

function conflicts(
  first: FirstOperation,
  next: DnrHeaderModification,
  extensionId: string
): boolean {
  switch (first.operation) {
    case 'append':
      return next.operation !== 'append'
    case 'set':
      return first.extensionId !== extensionId || next.operation !== 'append'
    case 'remove':
      return true
  }
}

function findKey(headers: Record<string, unknown>, lowerName: string): string | undefined {
  return Object.keys(headers).find((key) => key.toLowerCase() === lowerName)
}

/** Removes every spelling of a header; returns whether anything was removed. */
function removeAll(headers: Record<string, unknown>, lowerName: string): boolean {
  let removed = false
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      delete headers[key]
      removed = true
    }
  }
  return removed
}

export type DnrHeaderModificationResult<T> = {
  headers: T
  /** Actions that changed at least one header; Chrome reports only these as matched. */
  appliedActions: DnrRequestAction[]
}

/** onBeforeSendHeaders: request headers are single-valued, keyed case-insensitively. */
export function applyDnrRequestHeaderActions(
  input: Readonly<Record<string, string>>,
  actions: readonly DnrRequestAction[]
): DnrHeaderModificationResult<Record<string, string>> {
  const headers: Record<string, string> = { ...input }
  const firstOperations = new Map<string, FirstOperation>()
  const appliedActions: DnrRequestAction[] = []
  for (const action of actions) {
    let modified = false
    for (const info of action.requestHeaders ?? []) {
      const extensionId = action.rule.extensionId
      const first = firstOperations.get(info.header)
      if (first && conflicts(first, info, extensionId)) {
        continue
      }
      if (!first) {
        firstOperations.set(info.header, { operation: info.operation, extensionId })
      }
      if (info.operation === 'remove') {
        modified = removeAll(headers, info.header) || modified
        continue
      }
      const key = findKey(headers, info.header)
      const value = info.value ?? ''
      const existing = key === undefined ? undefined : headers[key]
      headers[key ?? info.header] =
        info.operation === 'append' && existing !== undefined
          ? `${existing}${REQUEST_HEADER_APPEND_DELIMITERS.get(info.header) ?? ', '}${value}`
          : value
      modified = true
    }
    if (modified) {
      appliedActions.push(action)
    }
  }
  return { headers, appliedActions }
}

/** onHeadersReceived: response headers may repeat; append adds a line, set replaces all lines. */
export function applyDnrResponseHeaderActions(
  input: Readonly<Record<string, readonly string[]>>,
  actions: readonly DnrRequestAction[]
): DnrHeaderModificationResult<Record<string, string[]>> {
  const headers: Record<string, string[]> = {}
  for (const [key, values] of Object.entries(input)) {
    headers[key] = [...values]
  }
  const firstOperations = new Map<string, FirstOperation>()
  const appliedActions: DnrRequestAction[] = []
  for (const action of actions) {
    let modified = false
    for (const info of action.responseHeaders ?? []) {
      const extensionId = action.rule.extensionId
      const first = firstOperations.get(info.header)
      if (first && conflicts(first, info, extensionId)) {
        continue
      }
      if (!first) {
        firstOperations.set(info.header, { operation: info.operation, extensionId })
      }
      if (info.operation === 'remove') {
        modified = removeAll(headers, info.header) || modified
        continue
      }
      const key = findKey(headers, info.header)
      const value = info.value ?? ''
      if (info.operation === 'set' || key === undefined) {
        removeAll(headers, info.header)
        headers[key ?? info.header] = [value]
      } else {
        headers[key].push(value)
      }
      modified = true
    }
    if (modified) {
      appliedActions.push(action)
    }
  }
  return { headers, appliedActions }
}
