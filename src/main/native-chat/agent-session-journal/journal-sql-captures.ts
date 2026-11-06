import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalSqlValueReference } from './journal-sql-value-codec'

/** A field ('' for the whole value) that holds one incarnation of a whole entity. */
type Capture = {
  path: string
  source: string
  /** The captured entity's id column; items keep their encoded entry key. */
  id: string
  incarnation: string
}

type Holder = { name: string; table: string; captures: readonly Capture[] }

const submission: readonly Capture[] = [
  {
    path: '',
    source: 'submissions',
    id: 'submission_id',
    incarnation: 'submission_incarnation'
  }
]
const card: readonly Capture[] = [
  { path: '', source: 'queue.cards', id: 'card_id', incarnation: 'card_incarnation' }
]

/**
 * Holder families and the whole entities they hold, by their value types. A captured field keeps
 * the entity's identity across commands; any other shared object is plain data, saved inline.
 */
const HOLDERS: readonly Holder[] = [
  { name: 'order.queued', table: 'journal_proj_queued_inputs' },
  { name: 'order.entered', table: 'journal_proj_entered_inputs' },
  { name: 'order.overrides', table: 'journal_proj_send_overrides' },
  { name: 'evidence.recoverable', table: 'journal_proj_recoverable_inputs' },
  { name: 'evidence.statusPending', table: 'journal_proj_pending_status_inputs' },
  { name: 'inputs.candidates', table: 'journal_proj_input_candidates' },
  { name: 'inputs.rejections', table: 'journal_proj_input_rejections' },
  { name: 'phase:', table: 'journal_proj_phase_members' },
  { name: 'link-family:', table: 'journal_proj_link_family_members' }
]
  .map((holder) => ({ ...holder, captures: submission }))
  .concat([
    { name: 'cards.current', table: 'journal_proj_current_cards', captures: card },
    { name: 'cards.overlays', table: 'journal_proj_overlay_cards', captures: card },
    { name: 'inputs.presentations', table: 'journal_proj_input_presentations', captures: card },
    { name: '@index:places:', table: 'journal_proj_index_cards', captures: card },
    { name: '@index:domains:', table: 'journal_proj_index_cards', captures: card },
    { name: '@index:candidates:', table: 'journal_proj_index_cards', captures: card },
    {
      name: 'cards.indexed',
      table: 'journal_proj_indexed_cards',
      captures: [
        { path: 'card', source: 'queue.cards', id: 'card_id', incarnation: 'card_incarnation' },
        {
          path: 'source',
          source: 'inputCards',
          id: 'lineage_message_id',
          incarnation: 'lineage_incarnation'
        }
      ]
    },
    {
      name: 'inputs.handovers',
      table: 'journal_proj_input_handovers',
      captures: [
        {
          path: '',
          source: 'inputs.presentations',
          id: 'presentation_id',
          incarnation: 'presentation_incarnation'
        }
      ]
    },
    {
      name: '@index:turn-sources',
      table: 'journal_proj_turn_source_items',
      captures: [{ path: 'item', source: 'items', id: 'item_key', incarnation: 'item_incarnation' }]
    }
  ])

function holder(collection: string): Holder | undefined {
  return HOLDERS.find(({ name }) =>
    name.endsWith(':') ? collection.startsWith(name) : collection === name
  )
}

export function journalSqlCapturedPaths(collection: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    (holder(collection)?.captures ?? []).map(({ path, source }) => [path, source])
  )
}

/** SET assignments for a holder row's capture columns; an uncaptured field keeps its id column. */
export function journalSqlCaptureColumns(
  collection: string,
  refs: readonly JournalSqlValueReference[]
): { set: string; values: (string | number | null)[] } | undefined {
  const captures = holder(collection)?.captures
  if (!captures) {
    return undefined
  }
  const set: string[] = []
  const values: (string | number | null)[] = []
  for (const capture of captures) {
    const ref = refs.find((candidate) => candidate.path.join('.') === capture.path)
    if (ref) {
      set.push(`${capture.id}=?`)
      values.push(journalSqlSourceId(capture.source, ref.source.key))
    }
    set.push(`${capture.incarnation}=?`)
    values.push(ref?.source.incarnation ?? null)
  }
  return { set: set.join(', '), values }
}

/** The capture columns a holder's SELECT adds, aliased by their position. */
export function journalSqlCaptureSelect(collection: string): string {
  return (holder(collection)?.captures ?? [])
    .map(
      (capture, index) => `, ${capture.id} AS capture_id_${index},
      ${capture.incarnation} AS capture_incarnation_${index}`
    )
    .join('')
}

export function journalSqlCapturedRefs(
  collection: string,
  row: SqliteRow
): JournalSqlValueReference[] {
  return (holder(collection)?.captures ?? []).flatMap((capture, index) => {
    const incarnation = row[`capture_incarnation_${index}`]
    if (incarnation === null || incarnation === undefined) {
      return []
    }
    const id = String(row[`capture_id_${index}`])
    return [
      {
        path: capture.path === '' ? [] : capture.path.split('.'),
        source: {
          collection: capture.source,
          key: capture.source === 'items' ? id : JSON.stringify(id),
          incarnation: Number(incarnation),
          path: []
        }
      }
    ]
  })
}

/** Holder tables that can capture an entity of this collection, for retention checks. */
export function journalSqlCaptureHolders(
  source: string
): { table: string; id: string; incarnation: string }[] {
  const holders = new Map<string, { table: string; id: string; incarnation: string }>()
  for (const { table, captures } of HOLDERS) {
    for (const { source: captured, id, incarnation } of captures) {
      if (captured === source) {
        holders.set(`${table}.${id}`, { table, id, incarnation })
      }
    }
  }
  return [...holders.values()]
}

export function journalSqlSourceId(source: string, key: string): string {
  return source === 'items' ? key : String(JSON.parse(key))
}

/** Retention asks whether any holder row still captures an entity incarnation. */
export function journalSqlCaptureSchema(): string {
  const indexes = new Set<string>()
  for (const { table, captures } of HOLDERS) {
    for (const { id, incarnation } of captures) {
      indexes.add(`CREATE INDEX IF NOT EXISTS ${table}_${incarnation}
  ON ${table}(session_id, epoch, ${id}, ${incarnation}) WHERE ${incarnation} IS NOT NULL;`)
    }
  }
  return `\n${[...indexes].join('\n')}\n`
}
