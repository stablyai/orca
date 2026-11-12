import { z } from 'zod'
import {
  outcomeFormat1Stored,
  outcomeFormat1StoredScalars,
  type AdmittedOutcome
} from './journal-outcome-format-1'
import { admitOutcomeFormat2 } from './journal-outcome-format-2'
import type { QueuedMessageRow } from '../queued-messages/queued-message-table'
import { createJournalReducerState, type JournalReducerState } from '../projection/journal-reducer'
import { decodeOutcomeFormat1Onto } from './journal-outcome-format-1-decode'
import {
  storageVerdict,
  strictStorage,
  type StorageDeclaresAll,
  type UndeclaredStorageKeys
} from '../durable-rows/journal-storage-strict'

export const JOURNAL_OUTCOME_FORMAT_3 = 3

const storedCard = outcomeFormat1Stored['queue.cards']._def.items[1].extend({
  deliveryMode: z.enum(['queue', 'steer']).optional(),
  unattended: z.boolean().optional()
})
const strictCard = strictStorage(storedCard)
export const outcomeFormat3Card = z.custom<QueuedMessageRow>(
  (value) => strictCard.safeParse(value).success
)
const card = strictStorage(z.tuple([z.string(), storedCard]))

const storedStop = outcomeFormat1StoredScalars.shape.queuePauseMarks.shape.latestStop.unwrap()
const storedPauseMarks = outcomeFormat1StoredScalars.shape.queuePauseMarks.extend({
  manualStop: storedStop
    .extend({ event: storedStop.shape.event.extend({ reason: z.literal('user-stop') }) })
    .nullable()
    .optional()
})
const pauseMarks = strictStorage(storedPauseMarks)
export const outcomeFormat3PauseMarks = z.custom<JournalReducerState['queuePauseMarks']>(
  (value) => pauseMarks.safeParse(value).success
)
const completeScalars = strictStorage(
  outcomeFormat1StoredScalars.extend({ queuePauseMarks: storedPauseMarks })
)

/** Complete current scalars are checked in their own format before the frozen field decoder applies them. */
export function decodeOutcomeFormat3Onto(
  scalars: readonly [string, unknown][],
  baseline?: JournalReducerState
) {
  if (!baseline) {
    completeScalars.parse(Object.fromEntries(scalars))
  }
  return decodeOutcomeFormat1Onto(scalars, baseline ?? createJournalReducerState('', ''))
}

type StoredMarks = Omit<JournalReducerState['queuePauseMarks'], 'latestStop'> & {
  latestStop: z.output<typeof storedPauseMarks>['latestStop']
}
export type OutcomeFormat3DeclaresPauseKeys = StorageDeclaresAll<
  UndeclaredStorageKeys<StoredMarks, z.output<typeof storedPauseMarks>>
>

/** Format 3 gives waiting input one row and preserves the delivery intent accepted with it. */
export function admitOutcomeFormat3(value: {
  field: string
  key: string
  json: string
  deleted: boolean
}): 'unknown' | AdmittedOutcome {
  if (value.field === '$' && JSON.parse(value.key) === 'queuePauseMarks' && !value.deleted) {
    const kept: unknown = JSON.parse(value.json)
    const verdict = storageVerdict(pauseMarks, kept)
    if (verdict === 'newer') {
      return 'unknown'
    }
    if (verdict !== 'stored') {
      throw new Error('invalid queue pause marks')
    }
    return { entryKey: 'queuePauseMarks', kept }
  }
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
