import { expect, it } from 'vitest'
import type SyncDatabase from '../../sqlite/sync-database'
import {
  compactSessionSearchIndex,
  recordSessionSearchDeletedRows,
  sessionSearchIndexCompactionDue
} from './session-search-index-compaction'
import { insertRow } from './session-search-index-compaction.test-fixture'
import { openSessionSearchIndexFile } from './session-search-index-test-fixture'
import { SessionSearchStore } from './session-search-store'

/** 30 commits of 1,000 rows: thirty segments for one merge to combine. */
async function segmentedStore(name: string) {
  const index = await openSessionSearchIndexFile(name)
  const store = new SessionSearchStore(index.path)
  const db = store.connection
  db.exec(`INSERT INTO sessions(id,agent,session_id,file_path,title,resume_command)
    VALUES (1,'claude','one','one','compaction','')`)
  for (let commit = 0; commit < 30; commit++) {
    db.exec('BEGIN')
    for (let row = 0; row < 1000; row++) {
      insertRow(db, 1, commit * 1000 + row, commit)
    }
    db.exec('COMMIT')
  }
  // As if replacements had deleted enough rows to make compaction due.
  recordSessionSearchDeletedRows(db, 60_000)
  return { index, store, db }
}

async function compactCountingSteps(db: SyncDatabase, stopAfter: number | null): Promise<number> {
  let steps = 0
  let stopped = false
  await compactSessionSearchIndex(
    db,
    () => stopped,
    async () => {
      steps++
      // Indexing keeps committing between steps and between launches.
      insertRow(db, 1, 100_000 + steps, 0)
      stopped = stopAfter !== null && steps === stopAfter
    }
  )
  return steps
}

// #46549: a compaction cut short (quit, settings change) resumes its merge instead of restarting it.
it('resumes an interrupted compaction without redoing the merged work', async () => {
  const cut = await segmentedStore('ss-compaction-cut')
  try {
    // Each launch is cut short after 5 steps; the next one runs only while the pass is unfinished.
    let cutSteps = await compactCountingSteps(cut.db, 5)
    for (let launch = 1; launch < 10 && sessionSearchIndexCompactionDue(cut.db); launch++) {
      cutSteps += await compactCountingSteps(cut.db, 5)
    }
    // An uninterrupted pass takes 7 steps; restarting the merge each launch took 18.
    expect(cutSteps).toBeLessThanOrEqual(9)
    expect(sessionSearchIndexCompactionDue(cut.db)).toBe(false)
  } finally {
    cut.store.close()
    await cut.index.close()
  }
})
