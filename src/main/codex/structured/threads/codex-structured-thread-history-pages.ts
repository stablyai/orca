import { setImmediate } from 'node:timers/promises'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { CODEX_RESTORE_MAX_OPERATIONS } from '../journal/codex-structured-journal-translation-restore'
import {
  readCodexJournalRecord,
  readCodexJournalString
} from '../journal/codex-structured-journal-translation-values'
import type { CodexHistoryJournalView } from '../../history/journal-views/codex-history-journal-view'

function turnId(turn: Record<string, unknown>): string {
  const id = readCodexJournalString(turn, 'id')
  if (!id) {
    throw new Error('invalid-turn')
  }
  return id
}

type MissingPage = {
  cursor: string | null
  ids: string[]
  selected: Set<string>
  next: string | null
}
export type CodexHistoryRead = {
  connection: Pick<CodexAppServerConnection, 'request'>
  threadId: string
  signal: AbortSignal
  deadline: number
  check: () => void
}

async function readHistoryResponse(
  input: CodexHistoryRead,
  method: 'thread/turns/list' | 'thread/items/list',
  params: Record<string, unknown>
) {
  input.check()
  const page = readCodexJournalRecord(
    await waitForPromiseWithSignal(
      input.connection.request(
        method,
        { threadId: input.threadId, ...params },
        { timeoutMs: Math.max(1, input.deadline - Date.now()) }
      ),
      input.signal
    )
  )
  input.check()
  if (
    !Array.isArray(page.data) ||
    (page.nextCursor != null && typeof page.nextCursor !== 'string')
  ) {
    throw new Error('invalid-page')
  }
  return {
    data: page.data.map(readCodexJournalRecord),
    next: typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null
  }
}

async function readTurnItems(input: CodexHistoryRead, id: string) {
  const items: Record<string, unknown>[] = []
  const cursors = new Set<string | null>()
  const ids = new Set<string>()
  let cursor: string | null = null
  do {
    if (cursors.has(cursor)) {
      throw new Error('invalid-item-cursor')
    }
    cursors.add(cursor)
    const page = await readHistoryResponse(input, 'thread/items/list', {
      turnId: id,
      cursor,
      sortDirection: 'asc',
      limit: 16
    })
    for (const entry of page.data) {
      const item = readCodexJournalRecord(entry.item)
      const itemId = readCodexJournalString(item, 'id')
      if (entry.turnId !== id || !itemId || ids.has(itemId)) {
        throw new Error('invalid-history-item')
      }
      ids.add(itemId)
      items.push(item)
    }
    cursor = page.next
  } while (cursor !== null)
  return items
}

async function readPage(
  input: CodexHistoryRead,
  cursor: string | null,
  itemsView: 'summary' | 'full'
) {
  // A single image-heavy turn can exceed V8's string limit in a full turn response.
  const page = await readHistoryResponse(input, 'thread/turns/list', {
    cursor,
    sortDirection: 'desc',
    limit: 100,
    itemsView: 'summary'
  })
  const turns = page.data
  const ids = turns.map(turnId)
  if (itemsView === 'full') {
    for (const turn of turns) {
      turn.items = await readTurnItems(input, turnId(turn))
      turn.itemsView = 'full'
    }
  }
  return { turns, ids, next: page.next }
}

export function selectCodexHistoryTurn(
  turn: Record<string, unknown>,
  anchor: CodexHistoryJournalView
): boolean {
  if (anchor.covered?.has(turnId(turn))) {
    return false
  }
  if (anchor.unresolvedOrigin) {
    throw new Error('no-legacy-origin')
  }
  if (anchor.importedAt !== null) {
    if (typeof turn.startedAt !== 'number' || !Number.isFinite(turn.startedAt)) {
      throw new Error('undated-turn')
    }
    return turn.startedAt * 1000 > anchor.importedAt
  }
  return true
}

/** Known identities exclude themselves, never the older gaps behind them. */
export async function discoverCodexHistory(
  input: CodexHistoryRead,
  anchor: CodexHistoryJournalView
) {
  if (anchor.unresolvedOrigin) {
    throw new Error('no-legacy-origin')
  }
  const pages: MissingPage[] = []
  const seen = new Set<string>()
  const cursors = new Set<string | null>()
  let cursor: string | null = null
  let count = 0
  do {
    if (cursors.has(cursor)) {
      throw new Error('invalid-cursor')
    }
    cursors.add(cursor)
    const page = await readPage(input, cursor, 'summary')
    const selected = new Set<string>()
    for (const turn of page.turns) {
      const id = turnId(turn)
      if (seen.has(id)) {
        throw new Error('repeated-turn')
      }
      seen.add(id)
      const missingAnswer =
        !anchor.assistants?.has(id) &&
        Array.isArray(turn.items) &&
        turn.items.some((item) => readCodexJournalRecord(item).type === 'agentMessage')
      if (
        !selectCodexHistoryTurn(turn, anchor) ||
        (anchor.known.has(id) && anchor.terminal?.has(id) && !missingAnswer)
      ) {
        continue
      }
      selected.add(id)
      // Even empty turns consume a lifecycle row in the restore budget.
      if (++count > CODEX_RESTORE_MAX_OPERATIONS) {
        throw new Error('too-large')
      }
    }
    if (selected.size) {
      pages.push({ cursor, ids: page.ids, selected, next: page.next })
    }
    cursor = page.next
    await setImmediate()
  } while (cursor !== null)
  return {
    pages,
    order: [...seen].toReversed(),
    rewound: anchor.latest !== null && !seen.has(anchor.latest)
  }
}

/** Same cursor semantics in both views; reject a provider that changed selection between reads. */
export async function* loadCodexHistory(
  input: CodexHistoryRead,
  pages: readonly MissingPage[],
  onReadTurn: (turn: Record<string, unknown>) => Promise<void>
) {
  for (const descriptor of pages.toReversed()) {
    const page = await readPage(input, descriptor.cursor, 'full')
    if (
      page.next !== descriptor.next ||
      JSON.stringify(page.ids) !== JSON.stringify(descriptor.ids)
    ) {
      throw new Error('changed-page')
    }
    for (const turn of page.turns.toReversed()) {
      input.check()
      if (turn.itemsView !== 'full' || !Array.isArray(turn.items)) {
        throw new Error('summary-turn')
      }
    }
    for (const turn of page.turns.toReversed()) {
      input.check()
      await onReadTurn(turn)
    }
    for (const turn of page.turns.toReversed()) {
      yield turn
    }
  }
}

/** Recent exact-proof reads have their own open budget, independent of transcript import. */
export async function* loadCodexReceiptHistory(input: CodexHistoryRead) {
  const cursors = new Set<string | null>()
  let cursor: string | null = null
  let count = 0
  do {
    if (cursors.has(cursor)) {
      throw new Error('invalid-cursor')
    }
    cursors.add(cursor)
    const page = await readPage(input, cursor, 'full')
    for (const turn of page.turns) {
      input.check()
      if (++count > CODEX_RESTORE_MAX_OPERATIONS) {
        return
      }
      if (Array.isArray(turn.items)) {
        yield turn
      }
    }
    cursor = page.next
    await setImmediate()
  } while (cursor !== null)
}
