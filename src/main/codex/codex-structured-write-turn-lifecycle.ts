export type CodexStructuredWriteTurn = { threadId: string; turnId: string }

export const structuredWriteItemKey = (sessionId: string, itemId: string): string =>
  `${encodeURIComponent(sessionId)}:${encodeURIComponent(itemId)}`

export function notificationCompletesStructuredWriteTurn(
  active: CodexStructuredWriteTurn | null,
  params: unknown
): boolean {
  const record = asRecord(params)
  const turn = asRecord(record.turn)
  const threadId = readString(record, 'threadId')
  const turnId = readString(turn, 'id')
  return Boolean(
    active && turnId && active.turnId === turnId && (!threadId || active.threadId === threadId)
  )
}

export async function waitForStructuredWriteTurnEnd(
  current: () => CodexStructuredWriteTurn | null,
  expected: CodexStructuredWriteTurn,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const active = current()
    if (!active || active.threadId !== expected.threadId || active.turnId !== expected.turnId) {
      return true
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  return false
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}
