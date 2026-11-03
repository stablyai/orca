import type { JournalEffectResult, JournalPersistenceEffect } from './journal-persistence-plan'

const PACKET_BYTES = 256 * 1024
export type JournalUnitPacket = { index: number; effect: JournalPersistenceEffect }

/** Atomic units stage bounded packets before BEGIN; one indivisible encoded value can exceed target. */
export function* journalTransferBatches<T>(values: Iterable<T>): Generator<T[]> {
  let batch: T[] = [],
    bytes = 0
  for (const value of values) {
    const size = Buffer.byteLength(
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'bigint' ? item.toString() : item instanceof Set ? [...item] : item
      )
    )
    if (batch.length && bytes + size > PACKET_BYTES) {
      yield batch
      batch = []
      bytes = 0
    }
    batch.push(value)
    bytes += size
    if (batch.length >= 128 || bytes >= PACKET_BYTES) {
      yield batch
      batch = []
      bytes = 0
    }
  }
  if (batch.length) {
    yield batch
  }
}
export function* journalUnitPackets(
  effects: readonly JournalPersistenceEffect[]
): Generator<JournalUnitPacket> {
  for (const [index, effect] of effects.entries()) {
    if (effect.kind === 'outcomes') {
      yield { index, effect: { ...effect, values: [] } }
      for (const values of journalTransferBatches(effect.values)) {
        yield { index, effect: { ...effect, values } }
      }
    } else if (effect.kind === 'rows') {
      yield { index, effect: { ...effect, rows: [] } }
      for (const rows of journalTransferBatches(effect.rows)) {
        yield { index, effect: { ...effect, rows } }
      }
    } else if (effect.kind === 'queue-delete') {
      yield { index, effect: { ...effect, ids: [] } }
      for (const ids of journalTransferBatches(effect.ids)) {
        yield { index, effect: { ...effect, ids } }
      }
    } else if (effect.kind === 'claim') {
      const base = {
        ...effect,
        claim: { ...effect.claim, uploadIds: new Set<string>(), required: [] }
      }
      yield { index, effect: base }
      for (const ids of journalTransferBatches([...effect.claim.uploadIds])) {
        yield { index, effect: { ...base, claim: { ...base.claim, uploadIds: new Set(ids) } } }
      }
      for (const required of journalTransferBatches(effect.claim.required)) {
        yield { index, effect: { ...base, claim: { ...base.claim, required } } }
      }
    } else if (effect.kind === 'sweep' && effect.operation.kind === 'prune') {
      yield { index, effect: { ...effect, operation: { kind: 'prune', pairs: [] } } }
      for (const pairs of journalTransferBatches(effect.operation.pairs)) {
        yield { index, effect: { ...effect, operation: { kind: 'prune', pairs } } }
      }
    } else if (effect.kind === 'store') {
      const base: Extract<JournalPersistenceEffect, { kind: 'store' }> = {
        ...effect,
        writes: {
          records: { upsert: [], remove: [] },
          operations: { upsert: [], remove: [] },
          retiredClaimKeys: effect.writes.retiredClaimKeys === null ? null : [],
          sessionTabs: effect.writes.sessionTabs && { ...effect.writes.sessionTabs, tabs: [] }
        }
      }
      yield { index, effect: base }
      for (const family of ['records', 'operations'] as const) {
        for (const upsert of journalTransferBatches(effect.writes[family].upsert)) {
          yield {
            index,
            effect: { ...base, writes: { ...base.writes, [family]: { upsert, remove: [] } } }
          }
        }
        for (const remove of journalTransferBatches(effect.writes[family].remove)) {
          yield {
            index,
            effect: { ...base, writes: { ...base.writes, [family]: { upsert: [], remove } } }
          }
        }
      }
      for (const retiredClaimKeys of journalTransferBatches(effect.writes.retiredClaimKeys ?? [])) {
        yield { index, effect: { ...base, writes: { ...base.writes, retiredClaimKeys } } }
      }
      if (effect.writes.sessionTabs) {
        for (const tabs of journalTransferBatches(effect.writes.sessionTabs.tabs)) {
          yield {
            index,
            effect: {
              ...base,
              writes: { ...base.writes, sessionTabs: { ...effect.writes.sessionTabs, tabs } }
            }
          }
        }
      }
    } else {
      yield { index, effect }
    }
  }
}

export function appendJournalUnitPacket(
  current: JournalPersistenceEffect,
  incoming: JournalPersistenceEffect
): void {
  if (current.kind === 'outcomes' && incoming.kind === 'outcomes') {
    for (const value of incoming.values) {
      current.values.push(value)
    }
  } else if (current.kind === 'rows' && incoming.kind === 'rows') {
    for (const row of incoming.rows) {
      current.rows.push(row)
    }
  } else if (current.kind === 'queue-delete' && incoming.kind === 'queue-delete') {
    for (const id of incoming.ids) {
      current.ids.push(id)
    }
  } else if (current.kind === 'claim' && incoming.kind === 'claim') {
    for (const id of incoming.claim.uploadIds) {
      current.claim.uploadIds.add(id)
    }
    for (const id of incoming.claim.required) {
      current.claim.required.push(id)
    }
  } else if (
    current.kind === 'sweep' &&
    incoming.kind === 'sweep' &&
    current.operation.kind === 'prune' &&
    incoming.operation.kind === 'prune'
  ) {
    for (const pair of incoming.operation.pairs) {
      current.operation.pairs.push(pair)
    }
  } else if (current.kind === 'store' && incoming.kind === 'store') {
    for (const family of ['records', 'operations'] as const) {
      for (const row of incoming.writes[family].upsert) {
        current.writes[family].upsert.push(row)
      }
      for (const key of incoming.writes[family].remove) {
        current.writes[family].remove.push(key)
      }
    }
    if (current.writes.retiredClaimKeys && incoming.writes.retiredClaimKeys) {
      for (const key of incoming.writes.retiredClaimKeys) {
        current.writes.retiredClaimKeys.push(key)
      }
    }
    if (current.writes.sessionTabs && incoming.writes.sessionTabs) {
      for (const tab of incoming.writes.sessionTabs.tabs) {
        current.writes.sessionTabs.tabs.push(tab)
      }
    }
  } else {
    throw new Error('journal upload changed its persistence family')
  }
}

export type JournalResultPacket = { index: number; value: JournalEffectResult }
export function* journalResultPackets(
  values: readonly JournalEffectResult[]
): Generator<JournalResultPacket[]> {
  const pieces: JournalResultPacket[] = []
  for (const [index, value] of values.entries()) {
    if (typeof value === 'object' && value !== null) {
      pieces.push({ index, value: { referenced: new Set(), inserted: [] } })
      for (const ids of journalTransferBatches([...value.referenced])) {
        pieces.push({ index, value: { referenced: new Set(ids), inserted: [] } })
      }
      for (const inserted of journalTransferBatches(value.inserted)) {
        pieces.push({ index, value: { referenced: new Set(), inserted } })
      }
    } else {
      pieces.push({ index, value })
    }
  }
  yield* journalTransferBatches(pieces)
}
export function receiveJournalResult(
  values: JournalEffectResult[],
  packet: JournalResultPacket
): void {
  const current = values[packet.index],
    incoming = packet.value
  if (
    typeof current === 'object' &&
    current !== null &&
    typeof incoming === 'object' &&
    incoming !== null
  ) {
    for (const id of incoming.referenced) {
      current.referenced.add(id)
    }
    for (const id of incoming.inserted) {
      current.inserted.push(id)
    }
  } else {
    values[packet.index] = incoming
  }
}
