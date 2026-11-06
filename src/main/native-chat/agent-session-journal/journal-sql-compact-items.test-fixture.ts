import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { SqliteBindings } from '../../sqlite/sqlite-statement'
import type { JournalReducerState } from './journal-reducer'
import type { JournalOutcomeItemProvenance } from './journal-outcome-item-provenance'
import type { JournalSqlScope } from './journal-sql-scope'
import { memoryJournalMap } from './journal-memory-collections'
import { journalSqlItemMetadata } from './journal-sql-item-values'
import { decodeJournalOutcomeItem } from './journal-outcome-codec'

export const compactJournalItemColumns = {
  domain_items:
    'entry_key,incarnation,current,map_ordinal,sequence,sequence_index,revision,kind,turn_id,turn_item_id,opener_item_id,root,subagent_id,context_clear,byte_size,hidden,outcome_generation,outcome_seq,outcome_key,outcome_format,inline_json'
} as const

/** Item-only rejection floor; no production opener or control adapter selects this table. */
export function createCompactJournalItemSchema(scope: JournalSqlScope): void {
  scope.db.exec(`CREATE TABLE journal_proj_domain_items (
    session_id TEXT NOT NULL, generation TEXT NOT NULL, entry_key TEXT NOT NULL,
    incarnation INTEGER NOT NULL, current INTEGER NOT NULL CHECK(current IN (0,1)),
    map_ordinal INTEGER NOT NULL, sequence INTEGER NOT NULL, sequence_index INTEGER NOT NULL,
    revision INTEGER NOT NULL, kind TEXT NOT NULL, turn_id TEXT, turn_item_id TEXT,
    opener_item_id TEXT, root INTEGER NOT NULL, subagent_id TEXT,
    context_clear INTEGER NOT NULL, byte_size INTEGER NOT NULL, hidden INTEGER NOT NULL,
    outcome_generation INTEGER, outcome_seq INTEGER, outcome_key TEXT, outcome_format INTEGER,
    inline_json TEXT,
    PRIMARY KEY(session_id,generation,entry_key,incarnation),
    CHECK((outcome_generation IS NOT NULL AND outcome_seq IS NOT NULL
      AND outcome_key IS NOT NULL AND outcome_format IS NOT NULL AND inline_json IS NULL)
      OR (outcome_generation IS NULL AND outcome_seq IS NULL AND outcome_key IS NULL
        AND outcome_format IS NULL AND inline_json IS NOT NULL))
  ) WITHOUT ROWID;
  CREATE UNIQUE INDEX compact_items_current ON journal_proj_domain_items
    (session_id,generation,entry_key) WHERE current=1;
  CREATE INDEX compact_items_ordinal ON journal_proj_domain_items
    (session_id,generation,map_ordinal) WHERE current=1;
  CREATE INDEX compact_items_position ON journal_proj_domain_items
    (session_id,generation,sequence,sequence_index) WHERE current=1;
  CREATE INDEX compact_items_root ON journal_proj_domain_items
    (session_id,generation,sequence,sequence_index) WHERE current=1 AND root=1;
  CREATE INDEX compact_items_subagent ON journal_proj_domain_items
    (session_id,generation,subagent_id,sequence,sequence_index) WHERE current=1;
  CREATE INDEX compact_items_turn ON journal_proj_domain_items
    (session_id,generation,sequence DESC,map_ordinal DESC)
    WHERE current=1 AND (turn_id IS NOT NULL OR context_clear=1);
  CREATE INDEX compact_items_clear ON journal_proj_domain_items
    (session_id,generation,sequence DESC) WHERE current=1 AND context_clear=1;
  CREATE INDEX compact_items_opener ON journal_proj_domain_items
    (session_id,generation,opener_item_id) WHERE current=1 AND opener_item_id IS NOT NULL;`)
}

export class CompactJournalItems {
  readonly work = { pointers: 0, inline: 0, inlineBytes: 0, payloadMs: 0, metadataMs: 0 }
  constructor(
    private readonly state: JournalReducerState,
    private readonly provenance: JournalOutcomeItemProvenance,
    private readonly options: { diagnostics?: boolean } = {}
  ) {}

  *records(): Generator<{ table: 'domain_items'; values: SqliteBindings }> {
    let ordinal = 0
    for (const [id, item] of memoryJournalMap(this.state.items)) {
      ordinal++
      const started = this.options.diagnostics === false ? 0 : performance.now()
      const key = JSON.stringify(id)
      const source = this.provenance.source(item, key)
      let inline: string | null = null
      let bytes: number
      if (source) {
        this.work.pointers++
        bytes = source.bytes
      } else {
        inline = JSON.stringify(item)
        bytes = Buffer.byteLength(inline)
        this.work.inline++
        this.work.inlineBytes += bytes
      }
      if (this.options.diagnostics !== false) {
        this.work.payloadMs += performance.now() - started
      }
      const metadataStarted = this.options.diagnostics === false ? 0 : performance.now()
      const identity = parseAgentJournalItemKey(id)
      const hidden =
        identity?.provider === 'orca' &&
        this.state.inputs.rejections.has(identity.clientMessageId) &&
        !this.state.inputs.presentations.has(identity.clientMessageId)
      const metadata = journalSqlItemMetadata(item, bytes)
      if (this.options.diagnostics !== false) {
        this.work.metadataMs += performance.now() - metadataStarted
      }
      yield {
        table: 'domain_items',
        values: [
          key,
          ordinal,
          1,
          ordinal,
          ...metadata,
          Number(hidden),
          source?.generation ?? null,
          source?.sequence ?? null,
          source?.key ?? null,
          source?.format ?? null,
          inline
        ]
      }
    }
  }
}

/** Reads every current payload in restored Map order; this is not a page/control reader. */
export function* readCompactJournalItems(
  scope: JournalSqlScope
): Generator<[string, AgentJournalRenderItem]> {
  const outcome = scope.db.prepare(`SELECT seq,field,entry_key,format,ordinal,value_json,deleted
    FROM journal_outcomes WHERE generation=? AND seq=? AND field='items' AND entry_key=?`)
  for (const row of scope.db
    .prepare(`SELECT entry_key,outcome_generation,outcome_seq,
    outcome_key,outcome_format,inline_json FROM journal_proj_domain_items
    WHERE session_id=? AND generation=? AND current=1 ORDER BY map_ordinal`)
    .iterate(...scope.prefix)) {
    const key: string = JSON.parse(String(row.entry_key))
    if (typeof row.inline_json === 'string') {
      yield [key, JSON.parse(row.inline_json)]
    } else {
      const saved = outcome.get(row.outcome_generation, row.outcome_seq, row.outcome_key)
      if (!saved || saved.format !== row.outcome_format || saved.entry_key !== row.entry_key) {
        throw new Error('Invalid compact item source')
      }
      yield [key, decodeJournalOutcomeItem(saved)]
    }
  }
}
