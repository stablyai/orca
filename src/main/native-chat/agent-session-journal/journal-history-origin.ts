import { z } from 'zod'
import type { JournalEpochRow } from './journal-row-schema'

const text = z.string().min(1)
const handle = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('codex'), threadId: text }),
  z.object({ kind: z.literal('claude'), sessionId: text, leafUuid: text.nullable() }),
  z.object({ kind: z.literal('opaque'), agent: text, value: text })
])
const origin = z.object({
  version: z.literal(1),
  kind: z.literal('legacy_import'),
  providerHandle: handle,
  importedAt: z.number().finite()
})

/** Raw annotations survive replacement even when this host cannot use their version/shape. */
export type JournalHistoryOrigin = {
  providerHandle: JournalEpochRow['providerHandle']
  raw: unknown
}

export function sameJournalConversation(a: unknown, b: unknown): boolean {
  const left = handle.safeParse(a)
  const right = handle.safeParse(b)
  if (!left.success || !right.success) {
    return false
  }
  const x = left.data
  const y = right.data
  if (x.kind === 'codex' && y.kind === 'codex') {
    return x.threadId === y.threadId
  }
  if (x.kind === 'claude' && y.kind === 'claude') {
    return x.sessionId === y.sessionId
  }
  return x.kind === 'opaque' && y.kind === 'opaque' && x.agent === y.agent && x.value === y.value
}

export function journalHistoryOrigin(row: JournalEpochRow): JournalHistoryOrigin | null {
  const raw =
    row.reason === 'legacy_import'
      ? {
          version: 1,
          kind: 'legacy_import',
          providerHandle: row.providerHandle,
          importedAt: row.ts
        }
      : row.historyOrigin
  return raw === undefined ? null : { providerHandle: row.providerHandle, raw }
}

export function usableJournalHistoryOrigin(value: JournalHistoryOrigin | null) {
  if (!value) {
    return null
  }
  const parsed = origin.safeParse(value.raw)
  return parsed.success && sameJournalConversation(value.providerHandle, parsed.data.providerHandle)
    ? parsed.data
    : null
}
