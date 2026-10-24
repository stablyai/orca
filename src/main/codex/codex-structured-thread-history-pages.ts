import { setImmediate } from 'node:timers/promises'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CODEX_RESTORE_MAX_OPERATIONS } from './codex-structured-journal-translation-restore'
import {
  readCodexJournalRecord,
  readCodexJournalString
} from './codex-structured-journal-translation-values'
import type { CodexHistoryJournalView } from './codex-history-journal-view'

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

async function readPage(
  input: CodexHistoryRead,
  cursor: string | null,
  itemsView: 'summary' | 'full'
) {
  input.check()
  const page = readCodexJournalRecord(
    await waitForPromiseWithSignal(
      input.connection.request(
        'thread/turns/list',
        { threadId: input.threadId, cursor, sortDirection: 'desc', limit: 100, itemsView },
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
  const turns = page.data.map(readCodexJournalRecord)
  const ids = turns.map(turnId)
  return {
    turns,
    ids,
    next: typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null
  }
}

/** Known turns do not stop discovery of older gaps. */
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
      if (anchor.known.has(id)) {
        continue
      }
      if (anchor.importedAt !== null) {
        if (typeof turn.startedAt !== 'number' || !Number.isFinite(turn.startedAt)) {
          throw new Error('undated-turn')
        }
        if (turn.startedAt * 1000 <= anchor.importedAt) {
          continue
        }
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
  return { pages, rewound: anchor.latest !== null && !seen.has(anchor.latest) }
}

/** Reject pages that changed between summary discovery and full reads. */
export async function* loadCodexHistory(input: CodexHistoryRead, pages: readonly MissingPage[]) {
  for (const descriptor of pages.toReversed()) {
    const page = await readPage(input, descriptor.cursor, 'full')
    if (
      page.next !== descriptor.next ||
      JSON.stringify(page.ids) !== JSON.stringify(descriptor.ids)
    ) {
      throw new Error('changed-page')
    }
    for (const turn of page.turns.toReversed()) {
      if (!descriptor.selected.has(turnId(turn))) {
        continue
      }
      if (turn.itemsView !== 'full' || !Array.isArray(turn.items)) {
        throw new Error('summary-turn')
      }
      yield turn
    }
  }
}
