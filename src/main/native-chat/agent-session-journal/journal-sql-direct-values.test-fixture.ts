import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqliteBindings } from '../../sqlite/sqlite-statement'
import { memoryJournalMap } from './journal-memory-collections'
import type { JournalReducerState } from './journal-reducer'
import type { JournalOutcomeItemProvenance } from './journal-outcome-item-provenance'
import { journalSqlItemMetadata } from './journal-sql-item-values'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { encodeJournalSqlValue, type JournalSqlValueLocation } from './journal-sql-value-codec'

export const directJournalColumns = {
  values: 'collection,entry_key,ordinal,incarnation,value_json',
  collections: 'collection,size,next_ordinal,next_incarnation',
  value_refs:
    'holder_collection,holder_key,holder_incarnation,source_collection,source_key,source_incarnation',
  item_versions: 'entry_key,incarnation,outcome_generation,outcome_seq,inline_json',
  items:
    'entry_key,incarnation,ordinal,sequence,sequence_index,revision,kind,turn_id,turn_item_id,opener_item_id,root,subagent_id,context_clear,byte_size,hidden',
  scalars: 'owner,name,value_json',
  clear_members: 'ordinal,message_id',
  places: 'index_id,id,domain,sequence,tie,position,head,command,waiting,handoff,card_json',
  domains: 'index_id,id,introduced,domain,sequence,position,head,command,waiting,handoff,card_json',
  release_state: 'index_id,floor,pause_gen',
  releases: 'index_id,id,introduced,position,pause_gen',
  candidates: 'index_id,id,position,is_mail,card_json',
  turn_sources: 'id,sequence,sequence_index,ordinary,relevant,source_json',
  submissions:
    'entry_key,item_key,input_ordinal,fingerprint,submitted_at,accepted_seq,dispatch_state,write_failure,echo_claimed,item_present,item_sequence,item_unscoped',
  input_candidates: 'entry_key,ordinal,effective_fence,handover_fence',
  aliases: 'entry_key,target_key,ordinal',
  native_entries: 'entry_key,basis'
} as const

export type DirectJournalRecord = {
  table: keyof typeof directJournalColumns
  values: SqliteBindings
}

/** Scoped feasibility encoder: no SQL connection, reducer shell or retained encoded-row array. */
export class DirectJournalValues {
  private readonly sizes = new Map<string, number>()
  private readonly locations = new WeakMap<object, JournalSqlValueLocation>()
  readonly work = { pointers: 0, inline: 0, inlineBytes: 0, registered: 0 }

  constructor(
    private readonly state: JournalReducerState,
    private readonly provenance: JournalOutcomeItemProvenance
  ) {
    let ordinal = 0
    for (const [key, value] of memoryJournalMap(state.items)) {
      ordinal++
      this.register(value, {
        collection: 'items',
        key: JSON.stringify(key),
        incarnation: ordinal,
        path: []
      })
    }
  }

  private register(value: unknown, location: JournalSqlValueLocation): void {
    if (typeof value !== 'object' || value === null || this.locations.has(value)) {
      return
    }
    this.locations.set(value, location)
    this.work.registered++
    for (const [key, child] of Object.entries(value)) {
      this.register(child, { ...location, path: [...location.path, key] })
    }
  }

  *value(collection: string, key: unknown, value: unknown): Generator<DirectJournalRecord> {
    const ordinal = (this.sizes.get(collection) ?? 0) + 1
    this.sizes.set(collection, ordinal)
    const location = { collection, key: JSON.stringify(key), incarnation: ordinal, path: [] }
    if (collection === 'items') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the typed items map is passed under this collection name.
      const item = value as AgentJournalRenderItem
      const source = this.provenance.source(item, location.key)
      let token: string
      let bytes: number
      if (source) {
        this.work.pointers++
        bytes = source.bytes
        token = '{"refs":[]}'
        yield {
          table: 'item_versions',
          values: [location.key, ordinal, source.generation, source.sequence, null]
        }
      } else {
        const encoded = this.encode(value, location)
        token = JSON.stringify({ refs: encoded.refs })
        bytes = Buffer.byteLength(encoded.json)
        this.work.inline++
        this.work.inlineBytes += bytes
        yield { table: 'item_versions', values: [location.key, ordinal, null, null, encoded.json] }
        yield* this.references(location, encoded.refs)
      }
      const identity = parseAgentJournalItemKey(String(key))
      const hidden =
        identity?.provider === 'orca' &&
        this.state.inputs.rejections.has(identity.clientMessageId) &&
        !this.state.inputs.presentations.has(identity.clientMessageId)
      yield {
        table: 'items',
        values: [
          location.key,
          ordinal,
          ordinal,
          ...journalSqlItemMetadata(item, bytes),
          Number(hidden)
        ]
      }
      yield { table: 'values', values: [collection, location.key, ordinal, ordinal, token] }
    } else {
      const encoded = this.encode(value, location)
      yield { table: 'values', values: [collection, location.key, ordinal, ordinal, encoded.json] }
      yield* this.references(location, encoded.refs)
    }
  }

  private encode(value: unknown, location: JournalSqlValueLocation) {
    return encodeJournalSqlValue(
      value,
      location,
      (object) => this.locations.get(object),
      (object, path) => {
        if (!this.locations.has(object)) {
          this.locations.set(object, { ...location, path })
          this.work.registered++
        }
      }
    )
  }

  private *references(
    location: JournalSqlValueLocation,
    refs: ReturnType<typeof encodeJournalSqlValue>['refs']
  ): Generator<DirectJournalRecord> {
    for (const { source } of refs) {
      yield {
        table: 'value_refs',
        values: [
          location.collection,
          location.key,
          location.incarnation,
          source.collection,
          source.key,
          source.incarnation
        ]
      }
    }
  }

  *index(name: string, key: string, value: unknown): Generator<DirectJournalRecord, string> {
    const collection = `@index:${name}`
    yield* this.value(collection, key, value)
    return JSON.stringify({
      collection,
      key: JSON.stringify(key),
      incarnation: this.sizes.get(collection),
      path: []
    })
  }

  *finish(): Generator<DirectJournalRecord> {
    for (const [collection, size] of this.sizes) {
      yield { table: 'collections', values: [collection, size, size, size] }
    }
  }
}
