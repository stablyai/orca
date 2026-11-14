// What the voice model hears about this chat before it speaks: the latest requests, final answers
// and earlier voice exchanges of this one thread, read from Codex's canonical timeline. No tool
// output, reasoning, commentary, other threads or workspace listing is included.

import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { readRecord, readString } from '../../app-server/codex-item-field-readers'
import { codexRealtimeDelegationInput } from '../items/codex-realtime-delegation-text'

export type CodexVoiceInitialItem = { role: 'user' | 'assistant'; text: string }

/** A finished voice segment this process heard, kept for Codex builds whose timeline lacks it. */
export type CodexVoiceSpokenSegment = CodexVoiceInitialItem & { atMs: number }

const TIMELINE_PAGE = 80
// Codex accepts 128 items and about 8,192 tokens; stay far below both.
const MAX_ITEMS = 24
const MAX_ITEM_CHARS = 1_200
const MAX_TOTAL_CHARS = 8_000
const HISTORY_TIMEOUT_MS = 5_000
const TURNS_PAGE = 12

/** Best effort: without readable history the voice starts empty; the executor keeps it all. */
export async function readCodexVoiceInitialItems(
  connection: CodexAppServerConnection,
  threadId: string,
  spoken: readonly CodexVoiceSpokenSegment[] = []
): Promise<CodexVoiceInitialItem[]> {
  const read = (method: string, params: Record<string, unknown>) =>
    connection
      .request(method, { threadId, ...params }, { timeoutMs: HISTORY_TIMEOUT_MS })
      .then((page) => readRecord(page).data)
  try {
    const entries = await read('thread/timeline/list', { limit: TIMELINE_PAGE })
    if (Array.isArray(entries)) {
      return codexVoiceInitialItemsFromTimeline(entries)
    }
  } catch {
    // Codex 0.165 lists the protocol method but its local store answers "not supported yet".
  }
  try {
    const turns = await read('thread/turns/list', {
      limit: TURNS_PAGE,
      sortDirection: 'desc',
      itemsView: 'full'
    })
    return codexVoiceInitialItemsFromTimeline(
      timelineFromTurns(Array.isArray(turns) ? turns : [], spoken)
    )
  } catch {
    return codexVoiceInitialItemsFromTimeline(timelineFromTurns([], spoken))
  }
}

/** Newest-first turns as the oldest-first entries the timeline would list. Turns carry no voice,
 *  so the segments this process heard go before the first turn that started after them. */
function timelineFromTurns(
  turns: readonly unknown[],
  spoken: readonly CodexVoiceSpokenSegment[]
): unknown[] {
  let next = 0
  const spokenUntil = (atMs: number) => {
    const from = next
    while (next < spoken.length && spoken[next].atMs < atMs) {
      next += 1
    }
    return spoken.slice(from, next).map(({ role, text }) => ({
      type: 'realtime',
      item: { type: 'transcriptSegment', role, text }
    }))
  }
  const entries = turns.toReversed().flatMap((raw) => {
    const turn = readRecord(raw)
    const turnId = readString(turn, 'id') ?? ''
    const items = Array.isArray(turn.items) ? turn.items : []
    // Whole seconds: speech in the turn's own second is the hand-off that started it.
    const startedAt = turn.startedAt
    return [
      ...(typeof startedAt === 'number' ? spokenUntil((startedAt + 1) * 1_000) : []),
      ...items.map((item: unknown) => ({ type: 'item', turnId, item })),
      { type: 'turnCompleted', turnId }
    ]
  })
  return [...entries, ...spokenUntil(Number.POSITIVE_INFINITY)]
}

/** Timeline entries arrive oldest first; the newest exchanges win the budget. */
export function codexVoiceInitialItemsFromTimeline(
  entries: readonly unknown[]
): CodexVoiceInitialItem[] {
  const ordered: CodexVoiceInitialItem[] = []
  // A legacy model may leave its answer unphased; the turn's last message is then the answer,
  // unless the turn also gave a final answer.
  const unphasedAnswer = new Map<string, string>()
  const answeredTurns = new Set<string>()
  const spokenByUser = new Set<string>()
  for (const raw of entries) {
    const entry = readRecord(raw)
    const turnId = readString(entry, 'turnId') ?? ''
    const item = readRecord(entry.item)
    if (entry.type === 'realtime' && item.type === 'transcriptSegment') {
      const role = readString(item, 'role')
      const text = readString(item, 'text')
      if ((role === 'user' || role === 'assistant') && text) {
        ordered.push({ role, text })
        if (role === 'user') {
          spokenByUser.add(normalized(text))
        }
      }
    } else if (entry.type === 'item' && item.type === 'userMessage') {
      const raw = userText(item)
      const handedOff = raw === null ? null : codexRealtimeDelegationInput(raw)
      const text = handedOff ?? raw
      // A hand-off repeats speech only when this slice already holds that transcript.
      if (text && !(handedOff !== null && spokenByUser.has(normalized(handedOff)))) {
        ordered.push({ role: 'user', text })
      }
    } else if (entry.type === 'item' && item.type === 'agentMessage') {
      const text = readString(item, 'text')
      if (text && item.phase === 'final_answer') {
        ordered.push({ role: 'assistant', text })
        answeredTurns.add(turnId)
        unphasedAnswer.delete(turnId)
      } else if (
        text &&
        (item.phase === null || item.phase === undefined) &&
        !answeredTurns.has(turnId)
      ) {
        unphasedAnswer.set(turnId, text)
      }
    } else if (entry.type === 'turnCompleted') {
      const text = unphasedAnswer.get(turnId)
      unphasedAnswer.delete(turnId)
      answeredTurns.delete(turnId)
      if (text) {
        ordered.push({ role: 'assistant', text })
      }
    }
  }
  const kept: CodexVoiceInitialItem[] = []
  let total = 0
  for (const item of ordered.toReversed()) {
    const text =
      item.text.length > MAX_ITEM_CHARS ? `${item.text.slice(0, MAX_ITEM_CHARS)}…` : item.text
    if (kept.length === MAX_ITEMS || total + text.length > MAX_TOTAL_CHARS) {
      break
    }
    total += text.length
    kept.push({ role: item.role, text })
  }
  return kept.toReversed()
}

function userText(item: Record<string, unknown>): string | null {
  const content = Array.isArray(item.content) ? item.content : []
  const parts = content.flatMap((part: unknown) => {
    const text = readString(readRecord(part), 'text')
    return text ? [text] : []
  })
  return parts.length > 0 ? parts.join('\n') : null
}

function normalized(text: string): string {
  return text.trim().replaceAll(/\s+/g, ' ').toLowerCase()
}
