import { expect, it } from 'vitest'
import { openSessionSearchDatabase } from './session-search-schema'
import { openSessionSearchIndexFile } from './session-search-index-test-fixture'

it('rereads only Grok transcripts indexed before the synthetic-turn filter, once', async () => {
  const index = await openSessionSearchIndexFile('orca-search-grok-repair')
  try {
    for (const agent of ['grok', 'claude']) {
      const { lastInsertRowid } = index.db
        .prepare(
          "INSERT INTO sessions(agent, session_id, file_path, title, resume_command) VALUES (?, 's', ?, 't', 'r')"
        )
        .run(agent, agent)
      index.db
        .prepare(
          'INSERT INTO files(path, byte_offset, mtime_ms, session_row_id) VALUES (?, 0, 1, ?)'
        )
        .run(agent, lastInsertRowid)
    }
    index.db.prepare("DELETE FROM meta WHERE key = 'grok_files_version'").run()
    const cursors = (): unknown[] =>
      index.db.prepare('SELECT path, state, byte_offset FROM files ORDER BY path').all()

    openSessionSearchDatabase(index.path).close()
    // A partial cursor forces the reread without counting the file as due.
    expect(cursors()).toEqual([
      { path: 'claude', state: 'current', byte_offset: 0 },
      { path: 'grok', state: 'current', byte_offset: -1 }
    ])
    index.db.prepare('UPDATE files SET byte_offset = 0').run()
    openSessionSearchDatabase(index.path).close()
    expect(cursors()).toEqual([
      { path: 'claude', state: 'current', byte_offset: 0 },
      { path: 'grok', state: 'current', byte_offset: 0 }
    ])
  } finally {
    await index.close()
  }
})
