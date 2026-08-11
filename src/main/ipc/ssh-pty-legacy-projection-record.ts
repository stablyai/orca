import type {
  Mode2031ReplyDecision,
  Mode2031ReplyScanState
} from '../../shared/terminal-color-scheme-protocol'
import { INITIAL_MODE_2031_REPLY_SCAN_STATE } from '../../shared/terminal-color-scheme-protocol'
import type { TerminalOutputSourceRange } from '../../shared/terminal-output-source-range'

export type LegacySshProjectionIdentity = Readonly<{
  projectionSemanticsId: string
  ptyId: string
  providerGeneration: number
  ptyIncarnation: string
  displayStart: number
  displayEnd: number
  sequenceEnd: number
  rawLength: number
  transformed: boolean
}>

export type LegacySshProjectionSemantics = Readonly<{
  identity: LegacySshProjectionIdentity
  desktopSpan?: DesktopProjectionSpan
  beforeScanner: Readonly<Mode2031ReplyScanState>
  afterScanner: Readonly<Mode2031ReplyScanState>
  decision: Mode2031ReplyDecision
}>

export type DesktopProjectionSpan = Readonly<
  TerminalOutputSourceRange & {
    projectionSemanticsId: string
    transform: Readonly<{
      transformed: boolean
      rawLengthSu: number
      scalarSafe: boolean
    }>
  }
>

export type ProjectionState = 'reserved' | 'committed' | 'published'

export type ProjectionRecord = {
  semantics: LegacySshProjectionSemantics
  state: ProjectionState
  publishedDisplay: number
  publishedAccounting: number
  settledAccounting: number
}

export type PtyProjectionCursor = {
  providerGeneration: number
  ptyIncarnation: string
  displayEnd: number
  scanner: Mode2031ReplyScanState
}

export type LegacySshProjectionReservation = Readonly<{
  semantics: LegacySshProjectionSemantics
}>

export type LegacySshProjectionDebugSnapshot = {
  reserved: number
  committed: number
  published: number
  settled: number
  transferred: number
  rolledBack: number
  records: number
  cursors: number
}

export function scannerSnapshot(state: Mode2031ReplyScanState): Readonly<Mode2031ReplyScanState> {
  return Object.freeze({ tail: state.tail, pendingSubscribe: state.pendingSubscribe })
}

export function resetProjectionCursorForGap(
  cursors: ReadonlyMap<string, PtyProjectionCursor>,
  ptyId: string
): void {
  const cursor = cursors.get(ptyId)
  if (cursor) {
    cursor.scanner = { ...INITIAL_MODE_2031_REPLY_SCAN_STATE }
  }
}

export function projectionError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

export function projectionDebugSnapshot(
  records: ReadonlyMap<string, ProjectionRecord>,
  cursors: ReadonlyMap<string, PtyProjectionCursor>,
  terminalCounts: { settled: number; transferred: number; rolledBack: number }
): LegacySshProjectionDebugSnapshot {
  const result = {
    reserved: 0,
    committed: 0,
    published: 0,
    ...terminalCounts,
    records: records.size,
    cursors: cursors.size
  }
  for (const record of records.values()) {
    result[record.state]++
  }
  return result
}

export function reclaimProjectionRecord(
  records: Map<string, ProjectionRecord>,
  idsByPty: Map<string, string[]>,
  id: string,
  ptyId: string
): void {
  records.delete(id)
  const ids = idsByPty.get(ptyId)
  if (!ids) {
    return
  }
  const index = ids.indexOf(id)
  if (index >= 0) {
    ids.splice(index, 1)
  }
  if (ids.length === 0) {
    idsByPty.delete(ptyId)
  }
}

export function requireProjectionRecord(
  records: ReadonlyMap<string, ProjectionRecord>,
  id: string
): ProjectionRecord {
  const record = records.get(id)
  if (!record) {
    throw projectionError('ssh_projection_reservation_missing')
  }
  return record
}

export function rollbackCommittedProjectionRecord(
  records: Map<string, ProjectionRecord>,
  idsByPty: Map<string, string[]>,
  cursors: Map<string, PtyProjectionCursor>,
  reservation: LegacySshProjectionReservation
): string | null {
  const id = reservation.semantics.identity.projectionSemanticsId
  const record = records.get(id)
  if (!record || record.state !== 'committed') {
    return null
  }
  const { identity, beforeScanner } = record.semantics
  const cursor = cursors.get(identity.ptyId)
  if (
    idsByPty.get(identity.ptyId)?.at(-1) !== id ||
    !cursor ||
    cursor.providerGeneration !== identity.providerGeneration ||
    cursor.ptyIncarnation !== identity.ptyIncarnation ||
    cursor.displayEnd !== identity.displayEnd
  ) {
    return null
  }
  cursor.displayEnd = identity.displayStart
  cursor.scanner = { ...beforeScanner }
  reclaimProjectionRecord(records, idsByPty, id, identity.ptyId)
  return identity.ptyId
}

export function closeProjectionPty(
  cursors: Map<string, PtyProjectionCursor>,
  ptyId: string,
  providerGeneration: number,
  ptyIncarnation: string,
  beforeDelete: () => void
): void {
  const cursor = cursors.get(ptyId)
  if (
    !cursor ||
    cursor.providerGeneration !== providerGeneration ||
    cursor.ptyIncarnation !== ptyIncarnation
  ) {
    return
  }
  beforeDelete()
  cursors.delete(ptyId)
}

export function getOrCreateProjectionCursor(
  cursors: Map<string, PtyProjectionCursor>,
  args: { ptyId: string; providerGeneration: number; ptyIncarnation: string },
  replaceGeneration: (providerGeneration: number) => void
): PtyProjectionCursor {
  const existing = cursors.get(args.ptyId)
  if (!existing) {
    const cursor = {
      providerGeneration: args.providerGeneration,
      ptyIncarnation: args.ptyIncarnation,
      displayEnd: 0,
      scanner: { ...INITIAL_MODE_2031_REPLY_SCAN_STATE }
    }
    cursors.set(args.ptyId, cursor)
    return cursor
  }
  if (args.providerGeneration < existing.providerGeneration) {
    throw projectionError('ssh_projection_stale_generation')
  }
  if (
    args.providerGeneration === existing.providerGeneration &&
    args.ptyIncarnation !== existing.ptyIncarnation
  ) {
    throw projectionError('ssh_projection_stale_incarnation')
  }
  if (args.providerGeneration > existing.providerGeneration) {
    replaceGeneration(existing.providerGeneration)
    existing.providerGeneration = args.providerGeneration
    existing.ptyIncarnation = args.ptyIncarnation
    existing.scanner = { ...INITIAL_MODE_2031_REPLY_SCAN_STATE }
  }
  return existing
}
