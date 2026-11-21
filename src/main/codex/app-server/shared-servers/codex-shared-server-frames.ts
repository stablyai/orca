import { isProviderRecord } from '../../../provider-process/provider-json-record'
import type { CodexAppServerServerRequest } from '../codex-app-server-connection-types'
import { readCodexSubagentAnnouncements } from '../../structured/background-work/codex-subagent-activity'

export type CodexSharedServerFrame =
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; request: CodexAppServerServerRequest }

export function field(value: unknown, ...path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (!isProviderRecord(current)) {
      return undefined
    }
    current = current[key]
  }
  return current
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function codexSharedFrameParams(frame: CodexSharedServerFrame): unknown {
  return frame.kind === 'notification' ? frame.params : frame.request.params
}

/** The thread a frame belongs to; null for account- or server-wide frames. */
export function codexFrameThreadId(params: unknown): string | null {
  return stringOrNull(field(params, 'threadId')) ?? stringOrNull(field(params, 'thread', 'id'))
}

/** A subagent's thread belongs to the chat that owns its parent. */
export function codexSubagentParentThreadId(params: unknown): string | null {
  return stringOrNull(
    field(params, 'thread', 'source', 'subAgent', 'thread_spawn', 'parent_thread_id')
  )
}

/** The thread a thread/start, thread/resume or thread/fork reply opened. */
export function codexOpenedThreadId(result: unknown): string | null {
  return stringOrNull(field(result, 'thread', 'id'))
}

export function codexTurnId(params: unknown): string | null {
  return stringOrNull(field(params, 'turn', 'id')) ?? stringOrNull(field(params, 'turnId'))
}

function threadItem(value: unknown): { type: string; id: string; [key: string]: unknown } | null {
  return isProviderRecord(value) && typeof value.type === 'string'
    ? { ...value, type: value.type, id: typeof value.id === 'string' ? value.id : '' }
    : null
}

/** Helper threads an item on a parent names (a spawn, or a later message to that helper). Codex
 *  may announce a helper only this way, never with its own thread/started. */
export function codexChildThreadIdsInItem(value: unknown): string[] {
  const item = threadItem(value)
  return item ? readCodexSubagentAnnouncements(item, null).map((child) => child.agentThreadId) : []
}

/** Helpers named anywhere in a thread/resume, thread/read or thread/turns/list reply, so a chat
 *  reopened after a restart still owns the helpers its history spawned. */
export function codexChildThreadIdsInHistory(result: unknown): string[] {
  const turns = [field(result, 'thread', 'turns'), field(result, 'data')].flatMap((value) =>
    Array.isArray(value) ? value : []
  )
  return turns.flatMap((turn) => {
    const items = field(turn, 'items')
    return Array.isArray(items) ? items.flatMap(codexChildThreadIdsInItem) : []
  })
}
