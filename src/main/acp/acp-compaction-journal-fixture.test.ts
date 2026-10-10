import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState
} from '../native-chat/agent-session-journal/journal-reducer'
import { parseJournalRow } from '../native-chat/agent-session-journal/journal-row-schema'

async function capturedCompaction() {
  const text = await readFile(
    new URL('./fixtures/omp-v17-compact-skip.journal.jsonl', import.meta.url),
    'utf8'
  )
  const state = createJournalReducerState('session-1', 'epoch-1')
  for (const line of text.trim().split('\n')) {
    const parsed = parseJournalRow(line)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      throw new Error('Unreadable captured journal row')
    }
    applyJournalRow(state, parsed.row)
  }
  return renderJournalState(state)
}

it('replays the captured OMP skip into the renderer fixture without changing its outcome', async () => {
  const journal = await capturedCompaction()
  const expected: unknown = JSON.parse(
    await readFile(new URL('./fixtures/omp-v17-compact-skip.render.jsonl', import.meta.url), 'utf8')
  )
  expect({ items: journal.items, submissions: journal.submissions }).toEqual(expected)
})
