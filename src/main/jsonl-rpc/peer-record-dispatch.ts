import { z } from 'zod'

const recordSchema = z.looseObject({ type: z.string() })
const responseSchema = z.looseObject({
  type: z.literal('response'),
  id: z.string().optional(),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional()
})

export type JsonlRpcRecord = z.infer<typeof recordSchema>
export class JsonlRpcResponseError extends Error {
  constructor(
    readonly command: string,
    message: string
  ) {
    super(message)
    this.name = 'JsonlRpcResponseError'
  }
}
export type JsonlRpcPendingRequest = {
  command: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export function dispatchJsonlRpcRecord(
  value: unknown,
  pending: Map<string, JsonlRpcPendingRequest>,
  rejectPending: (id: string, error: Error) => void,
  onRecord: ((record: JsonlRpcRecord) => void) | undefined,
  diagnose: (message: string) => void
): void {
  const parsed = recordSchema.safeParse(value)
  if (!parsed.success) {
    const identified = z.object({ id: z.string() }).safeParse(value)
    if (identified.success) {
      rejectPending(identified.data.id, new Error('Invalid agent RPC response'))
    }
    diagnose('Ignored invalid agent RPC record')
    return
  }
  const record = parsed.data
  if (
    record.type !== 'response' &&
    record.type !== 'extension_ui_request' &&
    typeof record.id === 'string' &&
    pending.has(record.id) &&
    (Object.hasOwn(record, 'command') || Object.hasOwn(record, 'success'))
  ) {
    rejectPending(record.id, new Error('Invalid agent RPC response'))
    return
  }
  if (record.type === 'response' && typeof record.id === 'string') {
    const waiter = pending.get(record.id)
    if (!waiter) {
      return
    }
    const response = responseSchema.safeParse(record)
    if (!response.success || response.data.command !== waiter.command) {
      rejectPending(record.id, new Error('Invalid agent RPC response'))
      return
    }
    pending.delete(record.id)
    clearTimeout(waiter.timer)
    if (response.data.success) {
      waiter.resolve(response.data.data)
    } else {
      waiter.reject(
        new JsonlRpcResponseError(
          waiter.command,
          response.data.error ?? `Agent rejected ${waiter.command}`
        )
      )
    }
    return
  }
  onRecord?.(record)
}
