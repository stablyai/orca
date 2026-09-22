import { OrchestrationError } from '../orchestration-error'
import type { RunRow } from '../types'
import type { RunListCursor } from './run-list-page'

export function encodeRunListCursor(run: RunRow): string {
  const cursor: RunListCursor = { createdAt: run.created_at, id: run.id }
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

export function decodeRunListCursor(value: string): RunListCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as RunListCursor).createdAt !== 'string' ||
      typeof (parsed as RunListCursor).id !== 'string'
    ) {
      throw new Error('invalid cursor shape')
    }
    return parsed as RunListCursor
  } catch {
    throw new OrchestrationError('cursor_invalid', 'The Run list cursor is invalid.')
  }
}
