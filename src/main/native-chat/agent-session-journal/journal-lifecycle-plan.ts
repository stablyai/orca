import { isDeepStrictEqual } from 'node:util'
import { agentJournalLinkageFields } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { isolateJournalTransition } from './journal-reducer-transition'
import {
  applyJournalRow,
  applyJournalLifecycleMutation,
  type JournalReducerState
} from './journal-reducer'
import {
  journalLifecycleMutationForState,
  type JournalLifecycleMutationInput
} from './journal-lifecycle-mutation'
import { journalRowBase } from './journal-row-builders'
import { journalExecutionOriginForItem } from './journal-execution-item'
import {
  MAX_JOURNAL_LIFECYCLE_BATCH_BYTES,
  MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS,
  type JournalLifecycleBatchRow,
  type JournalLifecycleMutation,
  type JournalRow
} from './journal-row-schema'

export type LifecyclePlanInput = {
  settlementId: string
  fence: number
  recovered?: true
  ownerFence?: number
}

/** One isolated preparation spans dispatch, chunks and fallback rows, in their replay order. */
export function planJournalLifecycleRows(
  live: JournalReducerState,
  input: LifecyclePlanInput,
  mutations: readonly JournalLifecycleMutationInput[],
  first: number,
  ts: number,
  leading: (
    state: () => JournalReducerState
  ) => readonly ((seq: number, ts: number) => JournalRow)[] = () => [],
  distinct = false
): JournalRow[] {
  const state = isolateJournalTransition(live, () => undefined).state
  const rows: JournalRow[] = []
  const leaders = leading(() => state)
  for (const build of leaders) {
    const row = build(first + rows.length, ts)
    applyJournalRow(state, row)
    rows.push(row)
  }
  let draft = isolateJournalTransition(state, () => undefined).state
  let pending: JournalLifecycleMutation[] = []
  let pendingBytes = 0
  const seen = new Set<string>()
  let namedSettlement = false
  const rowFor = (
    parts: JournalLifecycleMutation[],
    id = input.settlementId
  ): JournalLifecycleBatchRow => ({
    kind: 'lifecycle-batch',
    settlementId: id,
    mutations: parts,
    ...journalRowBase(
      state.epoch,
      first + rows.length,
      input.fence,
      ts,
      parts.flatMap((part) => (part.kind === 'item' ? [part.body] : []))
    ),
    ...(input.recovered ? { recovered: input.recovered } : {})
  })
  const flush = () => {
    if (pending.length === 0) {
      return
    }
    const row = rowFor(
      pending,
      namedSettlement ? `${input.settlementId}:${rows.length + 1}` : input.settlementId
    )
    namedSettlement = true
    applyJournalRow(state, row)
    rows.push(row)
    pending = []
    pendingBytes = 0
    draft = isolateJournalTransition(state, () => undefined).state
  }
  const prepare = (mutation: JournalLifecycleMutationInput) => {
    let built = journalLifecycleMutationForState(draft, mutation, input.fence, new Map())
    if (!built) {
      return null
    }
    applyJournalLifecycleMutation(draft, rowFor([]), built, pending.length)
    if (
      built.kind === 'item' &&
      readAgentJournalTurn(built.body) &&
      mutation.itemId === undefined
    ) {
      const id = draft.aliases.get(built.itemId) ?? built.itemId
      const origin = journalExecutionOriginForItem(draft, id)
      if (origin) {
        built = { ...built, itemId: id, executionOrigin: origin }
      }
    }
    return built
  }
  for (const stated of mutations) {
    const mutation =
      stated.kind === 'item' && stated.ownerFence === undefined && input.ownerFence !== undefined
        ? { ...stated, ownerFence: input.ownerFence }
        : stated
    let built = prepare(mutation)
    if (!built) {
      continue
    }
    // Reserve schema and receipt overhead without repeatedly encoding pending payloads.
    const overhead =
      Buffer.byteLength(
        JSON.stringify({
          ...rowFor([], `${input.settlementId}:${mutations.length}/${mutations.length}`),
          v: 3
        }),
        'utf8'
      ) + 1
    const fits = (count: number, bytes: number) =>
      count <= MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS &&
      overhead + bytes + Math.max(0, count - 1) <= MAX_JOURNAL_LIFECYCLE_BATCH_BYTES
    let builtBytes = Buffer.byteLength(JSON.stringify(built), 'utf8')
    if (pending.length > 0 && !fits(pending.length + 1, pendingBytes + builtBytes)) {
      flush()
      built = prepare(mutation)
      if (!built) {
        continue
      }
      builtBytes = Buffer.byteLength(JSON.stringify(built), 'utf8')
    }
    const exactId =
      (built.kind === 'item' && built.executionOrigin) ||
      (built.kind === 'tombstone' && draft.tombstones.has(built.itemId))
        ? built.itemId
        : draft.items.has(built.itemId)
          ? built.itemId
          : (draft.aliases.get(built.itemId) ?? built.itemId)
    if (distinct && seen.has(exactId)) {
      throw new Error('journal_resolved_lifecycle_batch_names_item_twice')
    }
    seen.add(exactId)
    if (!fits(1, builtBytes)) {
      const previous = state.items.get(exactId)
      if (
        (built.kind === 'tombstone' && state.tombstones.has(exactId)) ||
        (built.kind === 'item' &&
          previous &&
          isDeepStrictEqual(previous.body, built.body) &&
          (!Object.hasOwn(built, 'echoOf') || state.itemEchoes.has(exactId)) &&
          isDeepStrictEqual(agentJournalLinkageFields(previous), agentJournalLinkageFields(built)))
      ) {
        draft = isolateJournalTransition(state, () => undefined).state
        continue
      }
      const row: JournalRow = {
        ...built,
        ...journalRowBase(
          state.epoch,
          first + rows.length,
          input.fence,
          built.kind === 'item' ? (built.observedAt ?? ts) : ts,
          built.kind === 'item' ? [built.body] : []
        ),
        ...(input.recovered ? { recovered: input.recovered } : {})
      }
      applyJournalRow(state, row)
      rows.push(row)
      draft = isolateJournalTransition(state, () => undefined).state
    } else {
      pending.push(built)
      pendingBytes += builtBytes
    }
  }
  flush()
  return rows
}
