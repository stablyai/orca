/**
 * The translator's provider-frame arms.
 *
 * Each returns null for a frame it does not own, which is the translator's
 * signal to keep looking. Split out so the translator reads as routing rather
 * than as the shape checks each arm performs.
 */

import type { CodexJournalTranslationAdmission } from './codex-structured-journal-contracts'
import { settleCodexOversizedNotification } from './codex-structured-journal-settlement'
import {
  readCodexJournalRecord,
  readCodexJournalString
} from './codex-structured-journal-translation-values'

type OversizedInput = Parameters<typeof settleCodexOversizedNotification>[0]

/** A notification the transport refused to carry whole: settle whatever it
 *  opened rather than leaving the item mid-flight. */
export function settleCodexOversizedNotificationFrame(input: {
  sessionId: string
  threadId: string
  kind: string
  payload: unknown
  sink: OversizedInput['sink']
  streams: OversizedInput['streams']
  activeItems: OversizedInput['activeItems']
}): CodexJournalTranslationAdmission | null {
  if (input.kind !== 'frame:oversized-notification') {
    return null
  }
  const method = readCodexJournalString(readCodexJournalRecord(input.payload), 'method')
  return method
    ? settleCodexOversizedNotification({
        sessionId: input.sessionId,
        threadId: input.threadId,
        method,
        sink: input.sink,
        streams: input.streams,
        activeItems: input.activeItems
      })
    : null
}
