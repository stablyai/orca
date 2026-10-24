import type { JournalReducerState } from './journal-reducer'
import type { JournalRow, JournalItemRow, JournalLifecycleBatchRow } from './journal-row-schema'
import type { JournalItemAppendOptions } from './journal-store-contracts'
import type { AgentSessionTextCuts } from '../agent-session-wire/agent-session-text-encoding'
import type { AgentSessionDeltaSource } from '../agent-session-wire/agent-session-delta-coalescer'

export type JournalTextDeltaRow = Omit<JournalItemRow, 'kind' | 'body'> & {
  kind: 'text-delta'
  field: number
  predecessor: number
  baseLength: number
  suffix: string
}

export class JournalTextPolicies extends Map<string, AgentSessionDeltaSource> {
  readonly raw = new Map<string, AgentSessionDeltaSource>()
  override set(key: string, source: AgentSessionDeltaSource): this {
    this.delete(key)
    super.set(key, source)
    if (source.live) {
      this.raw.set(source.live.key, source)
    }
    return this
  }
  override delete(key: string): boolean {
    const source = this.get(key)
    if (source?.live && this.raw.get(source.live.key) === source) {
      this.raw.delete(source.live.key)
    }
    return super.delete(key)
  }
}

export type JournalSequenceRange = readonly [number, number]

/** Host-only admission: the whole value is materialized only for an anchor or replacement. */
export type JournalTextAdmission = {
  applied?: (source: AgentSessionDeltaSource) => void
  operation: 'start' | 'append' | 'replace' | 'finish'
  cuts?: AgentSessionTextCuts
  source?: AgentSessionDeltaSource
  observedBytes?: number
  truncated?: boolean
  encodedBytes?: number
  limit?: number
  field: number
  baseLength: number
  suffix: string
  replace?: true
}

export function journalWholeItem(
  row: JournalItemRow | JournalLifecycleBatchRow,
  itemId: string,
  revision?: number
) {
  const item =
    row.kind === 'item'
      ? row
      : row.mutations.find(
          (mutation) =>
            mutation.kind === 'item' &&
            mutation.itemId === itemId &&
            (revision === undefined || mutation.revision === revision)
        )
  return item?.kind === 'item' &&
    item.itemId === itemId &&
    (revision === undefined || item.revision === revision)
    ? item
    : undefined
}

export function journalTextField(body: JournalItemRow['body'], field: number): string | null {
  const block = body.kind === 'message' ? body.blocks[field] : undefined
  return block?.type === 'text' ? block.text : null
}

export function journalTextFields(body: JournalItemRow['body']): number[] {
  return body.kind === 'message' && (body.role === 'assistant' || body.role === 'reasoning')
    ? body.blocks.flatMap((block, index) => (block.type === 'text' ? [index] : []))
    : []
}

export function withJournalText(body: JournalItemRow['body'], field: number, text: string) {
  if (body.kind !== 'message' || body.blocks[field]?.type !== 'text') {
    throw new Error('journal_text_field_missing')
  }
  return {
    ...body,
    blocks: body.blocks.map((block, index) =>
      index === field ? { type: 'text' as const, text } : block
    )
  }
}

export function journalTextRowContent(record: Record<string, unknown>): boolean {
  return (
    typeof record.itemId === 'string' &&
    record.itemId.length > 0 &&
    Number.isSafeInteger(record.field) &&
    Number(record.field) >= 0 &&
    Number.isSafeInteger(record.revision) &&
    Number(record.revision) > 0 &&
    record.kind === 'text-delta' &&
    Number.isSafeInteger(record.predecessor) &&
    Number(record.predecessor) > 0 &&
    Number(record.predecessor) < Number(record.revision) &&
    Number.isSafeInteger(record.baseLength) &&
    Number(record.baseLength) >= 0 &&
    typeof record.suffix === 'string' &&
    record.suffix.length > 0
  )
}

export function adoptJournalTextOperation(
  state: JournalReducerState,
  row: JournalRow,
  options: JournalItemAppendOptions
): void {
  if (row.kind !== 'item' && row.kind !== 'text-delta') {
    return
  }
  const item = state.items.get(row.itemId)
  if (item?.revision !== row.revision) {
    return
  }
  if (options.retireText || options.streamText?.operation === 'finish') {
    state.textPolicy.delete(row.itemId)
  } else if (options.streamText?.source) {
    state.textPolicy.set(row.itemId, options.streamText.source)
  }
  options.applied?.(row)
}
