import { z } from 'zod'
import { JsonlRpcResponseError } from './peer-errors'
export { JsonlRpcResponseError } from './peer-errors'

const responseSchema = z.looseObject({
  type: z.literal('response'),
  id: z.string().optional(),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional()
})

export type JsonlRpcPendingRequest = {
  command: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/** Settles the outstanding call a record answers; false when the record is no reply to one. */
export function settleJsonlRpcReply(
  record: { type: string; id?: unknown },
  pending: Map<string, JsonlRpcPendingRequest>,
  rejectPending: (id: string, error: Error) => void
): boolean {
  if (
    record.type !== 'response' &&
    record.type !== 'extension_ui_request' &&
    typeof record.id === 'string' &&
    pending.has(record.id) &&
    (Object.hasOwn(record, 'command') || Object.hasOwn(record, 'success'))
  ) {
    rejectPending(record.id, new Error('Invalid agent RPC response'))
    return true
  }
  if (record.type !== 'response' || typeof record.id !== 'string') {
    return false
  }
  const waiting = pending.get(record.id)
  if (!waiting) {
    return true
  }
  const response = responseSchema.safeParse(record)
  if (!response.success || response.data.command !== waiting.command) {
    rejectPending(record.id, new Error('Invalid agent RPC response'))
    return true
  }
  pending.delete(record.id)
  clearTimeout(waiting.timer)
  if (response.data.success) {
    waiting.resolve(response.data.data)
  } else {
    waiting.reject(
      new JsonlRpcResponseError(
        waiting.command,
        response.data.error ?? `Agent rejected ${waiting.command}`
      )
    )
  }
  return true
}
