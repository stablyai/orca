import { z } from 'zod'
import { outcomeFormat1Stored, type AdmittedOutcome } from './journal-outcome-format-1'
import { admitOutcomeFormat2 } from './journal-outcome-format-2'
import type { QueuedMessageRow } from '../queued-messages/queued-message-table'
import { storageVerdict, strictStorage } from '../durable-rows/journal-storage-strict'

export const JOURNAL_OUTCOME_FORMAT_3 = 3

const storedCard = outcomeFormat1Stored['queue.cards']._def.items[1].extend({
  deliveryMode: z.enum(['queue', 'steer']).optional(),
  unattended: z.boolean().optional()
})
export const outcomeFormat3Card = storedCard.pipe(z.custom<QueuedMessageRow>())
const card = strictStorage(z.tuple([z.string(), storedCard]))

/** Format 3 gives waiting input one row and preserves the delivery intent accepted with it. */
export function admitOutcomeFormat3(value: {
  field: string
  key: string
  json: string
  deleted: boolean
}): 'unknown' | AdmittedOutcome {
  if (value.field !== 'queue.cards') {
    return admitOutcomeFormat2(value)
  }
  const key: unknown = JSON.parse(value.key)
  if (typeof key !== 'string') {
    throw new Error('invalid queued journal key')
  }
  if (value.deleted) {
    return value.json === 'null' ? { entryKey: key, kept: null } : 'unknown'
  }
  const kept: unknown = JSON.parse(value.json)
  const verdict = storageVerdict(card, kept)
  if (verdict === 'newer') {
    return 'unknown'
  }
  if (verdict !== 'stored' || !Array.isArray(kept) || kept[0] !== key) {
    throw new Error('invalid queued journal outcome')
  }
  return { entryKey: key, kept }
}
