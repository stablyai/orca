/** Field path ('' for the whole value) to the entity collection whose incarnation it captures. */
type Captures = Readonly<Record<string, string>>

const SUBMISSION: Captures = { '': 'submissions' }
const CARD: Captures = { '': 'queue.cards' }

/**
 * Holder families and the whole entities they hold, by their value types. A captured field keeps
 * the entity's identity across commands; any other shared object is plain data, saved inline.
 */
const HOLDERS: readonly (readonly [string, Captures])[] = [
  ['order.queued', SUBMISSION],
  ['order.entered', SUBMISSION],
  ['order.overrides', SUBMISSION],
  ['evidence.recoverable', SUBMISSION],
  ['evidence.statusPending', SUBMISSION],
  ['inputs.candidates', SUBMISSION],
  ['inputs.rejections', SUBMISSION],
  ['phase:', SUBMISSION],
  ['link-family:', SUBMISSION],
  ['cards.current', CARD],
  ['cards.overlays', CARD],
  ['inputs.presentations', CARD],
  ['@index:places:', CARD],
  ['@index:domains:', CARD],
  ['@index:candidates:', CARD],
  ['cards.indexed', { card: 'queue.cards', source: 'inputCards' }],
  ['inputs.handovers', { '': 'inputs.presentations' }],
  ['@index:turn-sources', { item: 'items' }]
]

const NONE: Captures = {}

export function journalSqlCaptures(collection: string): Captures {
  for (const [name, captures] of HOLDERS) {
    if (name.endsWith(':') ? collection.startsWith(name) : collection === name) {
      return captures
    }
  }
  return NONE
}
