import { z } from 'zod'
import type { JournalEpochRow } from '../durable-rows/journal-row-schema'

const text = z.string().min(1)
const handle = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('codex'), threadId: text }),
  z.object({ kind: z.literal('claude'), sessionId: text, leafUuid: text.nullable() }),
  z.object({ kind: z.literal('opaque'), agent: text, value: text })
])
const legacyOrigin = z.object({
  version: z.literal(1),
  kind: z.literal('legacy_import'),
  providerHandle: handle,
  importedAt: z.number().finite()
})

const nativeCopyOrigin = z.object({
  version: z.literal(1),
  kind: z.literal('native_copy'),
  providerHandle: handle,
  unit: z.enum(['codex-turn', 'claude-entry', 'acp-user-message', 'zcode-turn']),
  agent: text,
  ids: z.array(text)
})
const origin = z.discriminatedUnion('kind', [legacyOrigin, nativeCopyOrigin])
export type NativeCopyCoverage = Pick<z.infer<typeof nativeCopyOrigin>, 'unit' | 'ids'>
export type NativeCopyOrigin = z.infer<typeof nativeCopyOrigin>
const parsedOrigins = new WeakMap<JournalHistoryOrigin, ReturnType<typeof origin.safeParse>>()

/** Preserve raw annotations even when this build cannot interpret them. */
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
  let parsed = parsedOrigins.get(value)
  if (!parsed) {
    parsed = origin.safeParse(value.raw)
    parsedOrigins.set(value, parsed)
  }
  return parsed.success && sameJournalConversation(value.providerHandle, parsed.data.providerHandle)
    ? parsed.data
    : null
}

const coveredIds = new WeakMap<NativeCopyOrigin, ReadonlySet<string>>()
export function nativeCopyIds(origin: NativeCopyOrigin): ReadonlySet<string> {
  let ids = coveredIds.get(origin)
  if (!ids) {
    ids = new Set(origin.ids)
    coveredIds.set(origin, ids)
  }
  return ids
}

/** A copy receipt applies only to the exact native conversation it was captured from. */
export function nativeCopyCoverage(
  value: JournalHistoryOrigin | null,
  agent: string,
  unit: NativeCopyOrigin['unit'],
  providerHandle: JournalEpochRow['providerHandle']
): ReadonlySet<string> | undefined {
  const copy = usableJournalHistoryOrigin(value)
  return copy?.kind === 'native_copy' &&
    copy.agent === agent &&
    copy.unit === unit &&
    sameJournalConversation(copy.providerHandle, providerHandle)
    ? nativeCopyIds(copy)
    : undefined
}

export function journalImportTime(
  value: JournalHistoryOrigin | null,
  providerHandle: JournalEpochRow['providerHandle']
): number | null {
  const imported = usableJournalHistoryOrigin(value)
  return imported?.kind === 'legacy_import' &&
    sameJournalConversation(imported.providerHandle, providerHandle)
    ? imported.importedAt
    : null
}
