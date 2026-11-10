import {
  isImageRefBlock,
  type NativeChatMessage
} from '../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatPendingSend } from '../../../../src/shared/native-chat/transcript/native-chat-pending-sends'
import {
  nativeChatPendingContentKey,
  nativeChatPendingMatchKey,
  nativeChatPendingOccurrence,
  selectPendingIndicesRepresentedByUserRows
} from '../../../../src/shared/native-chat/transcript/native-chat-pending-occurrence'
import {
  nativeChatPendingGluePiece,
  nativeChatPendingGluedRowText
} from '../../../../src/shared/native-chat/transcript/native-chat-pending-glue'
import {
  nativeChatReceiptWindow,
  type NativeChatReceiptSnapshot
} from '../../../../src/shared/native-chat/transcript/native-chat-source-receipts'

// Phone echoes never enter desktop source mode or inherit its consumption claims.
export type MobileNativeChatLegacyPending = Pick<
  NativeChatPendingSend,
  | 'id'
  | 'text'
  | 'sentAt'
  | 'queuedDuringWorkingEpoch'
  | 'afterMessageId'
  | 'afterMessageTimestamp'
  | 'afterEmptyTranscriptSessionId'
  | 'matchingOccurrence'
  | 'matchingAfterTimestamp'
>

type Summary = { visible: Set<string>; retained: Set<string> }
const summaries = new WeakMap<
  readonly MobileNativeChatLegacyPending[],
  WeakMap<readonly NativeChatMessage[], Summary>
>()
const contents = new WeakMap<NativeChatMessage, { text: string | null; key: string }>()
const snapshots = new WeakMap<readonly NativeChatMessage[], NativeChatReceiptSnapshot>()

function snapshotFor(messages: readonly NativeChatMessage[]): NativeChatReceiptSnapshot {
  const cached = snapshots.get(messages)
  if (cached) {
    return cached
  }
  const boundaries = new Map<string, number>()
  const rows = messages.map((message, index) => {
    if (!boundaries.has(message.id)) {
      boundaries.set(message.id, index)
    }
    return { message, index }
  })
  const snapshot = { rows, boundaries }
  snapshots.set(messages, snapshot)
  return snapshot
}

function content(message: NativeChatMessage): { text: string | null; key: string } {
  const cached = contents.get(message)
  if (cached) {
    return cached
  }
  const text = nativeChatPendingGluedRowText(message)
  const key = text
    ? `text:${text}`
    : nativeChatPendingContentKey({
        text: '',
        imagePaths: message.blocks
          .filter(isImageRefBlock)
          .map((block) => block.path)
          .filter((path): path is string => Boolean(path))
      })
  const result = { text, key }
  contents.set(message, result)
  return result
}

/** The phone keeps its exact-first, ordered residual glue policy for its full accepted-echo union. */
export function mobileNativeChatLegacyPendingSummary(
  pending: readonly MobileNativeChatLegacyPending[],
  messages: readonly NativeChatMessage[]
): Summary {
  let byMessages = summaries.get(pending)
  if (!byMessages) {
    summaries.set(pending, (byMessages = new WeakMap()))
  }
  const cached = byMessages.get(messages)
  if (cached) {
    return cached
  }
  const snapshot = snapshotFor(messages)
  const windows = pending.map((entry) => nativeChatReceiptWindow(entry, snapshot, ''))
  const glueWindows = pending.map((entry) => nativeChatReceiptWindow(entry, snapshot, '', true))
  const keys = pending.map(nativeChatPendingContentKey)
  const matchKeys = pending.map(nativeChatPendingMatchKey)
  function project(advanced: boolean): Set<string> {
    const lastAdvance = windows.map(
      (eligible) =>
        snapshot.rows.findLast((row) => row.message.role !== 'user' && eligible(row))?.index ?? -1
    )
    const consumed = new Map<string, number>()
    const residual: number[] = []
    for (const [index, entry] of pending.entries()) {
      let available = 0
      for (const row of snapshot.rows) {
        if (
          row.message.role === 'user' &&
          windows[index](row) &&
          (!advanced || row.index < lastAdvance[index]) &&
          content(row.message).key === keys[index] &&
          keys[index] !== 'empty'
        ) {
          available++
        }
      }
      const used = consumed.get(matchKeys[index]) ?? 0
      const occurrence = nativeChatPendingOccurrence(entry, used)
      consumed.set(matchKeys[index], Math.max(used, occurrence))
      if (occurrence > available) {
        residual.push(index)
      }
    }
    const open = residual.map((index) => pending[index])
    if (!open.length || (open.length === 1 && !nativeChatPendingGluePiece(open[0]).continuation)) {
      return new Set(open.map((entry) => entry.id))
    }
    const lastGlueAdvance = glueWindows.map(
      (eligible) =>
        snapshot.rows.findLast((row) => row.message.role !== 'user' && eligible(row))?.index ?? -1
    )
    const oldest = residual[0]
    const rows = snapshot.rows.flatMap((row) => {
      if (
        row.message.role !== 'user' ||
        !glueWindows[oldest](row) ||
        (advanced && row.index >= lastGlueAdvance[oldest])
      ) {
        return []
      }
      const text = content(row.message).text
      return text
        ? [
            {
              text,
              representablePendingIndices: new Set(
                residual.flatMap((index, at) =>
                  glueWindows[index](row) && (!advanced || row.index < lastGlueAdvance[index])
                    ? [at]
                    : []
                )
              )
            }
          ]
        : []
    })
    const represented = selectPendingIndicesRepresentedByUserRows(open, rows)
    return new Set(open.flatMap((entry, index) => (represented.has(index) ? [] : [entry.id])))
  }
  const result = { visible: project(false), retained: project(true) }
  byMessages.set(messages, result)
  return result
}
