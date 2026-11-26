import type { CodexStructuredSessionEvent } from '../session-lifecycle/codex-structured-session-state'
import { readRecord } from '../../app-server/codex-item-field-readers'
export function isCodexInstructionItem(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = readRecord(value)
  return (
    item.type === 'developerMessage' ||
    item.type === 'systemMessage' ||
    item.type === 'DeveloperMessage' ||
    item.type === 'SystemMessage' ||
    ((item.type === 'message' || item.type === 'developer' || item.type === 'system') &&
      (item.role === 'developer' || item.role === 'system'))
  )
}

export function codexInstructionNotification(params: unknown): boolean {
  if (!params || typeof params !== 'object') {
    return false
  }
  if (isCodexInstructionItem(params)) {
    return true
  }
  if ('item' in params && isCodexInstructionItem(params.item)) {
    return true
  }
  return (
    'msg' in params &&
    !!params.msg &&
    typeof params.msg === 'object' &&
    'item' in params.msg &&
    isCodexInstructionItem(params.msg.item)
  )
}

export function codexInstructionItemIdentity(params: unknown, ids: ReadonlySet<string>): boolean {
  if (!params || typeof params !== 'object') {
    return false
  }
  const frame = readRecord(params)
  if (typeof frame.itemId === 'string' && ids.has(frame.itemId)) {
    return true
  }
  if (
    frame.item &&
    typeof frame.item === 'object' &&
    'id' in frame.item &&
    typeof frame.item.id === 'string' &&
    ids.has(frame.item.id)
  ) {
    return true
  }
  return false
}

export function isHiddenCodexInstructionEvent(
  event: CodexStructuredSessionEvent,
  ids: ReadonlySet<string>
): boolean {
  return (
    ('params' in event &&
      (codexInstructionNotification(event.params) ||
        codexInstructionItemIdentity(event.params, ids))) ||
    (event.type === 'provider-frame' &&
      (codexInstructionNotification(event.payload) ||
        codexInstructionItemIdentity(event.payload, ids)))
  )
}
