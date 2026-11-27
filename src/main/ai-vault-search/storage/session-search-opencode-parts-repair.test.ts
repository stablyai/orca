import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openSessionSearchDatabase } from './session-search-schema'

it('rereads old OpenCode JSON search rows once while retaining SQLite cursors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-opencode-search-repair-'))
  const path = join(root, 'search.sqlite')
  let db = openSessionSearchDatabase(path)
  try {
    const session = db.prepare(
      'INSERT INTO sessions(agent, session_id, file_path, title, resume_command) VALUES (?, ?, ?, ?, ?)'
    )
    const file = db.prepare(
      'INSERT INTO files(path, byte_offset, mtime_ms, session_row_id) VALUES (?, 100, 1784109600000, ?)'
    )
    for (const [agent, source] of [
      ['opencode', '/storage/session/project/ses_saved.json'],
      ['opencode', '/storage/opencode.db#ses_other'],
      ['claude', '/projects/session.jsonl']
    ]) {
      const inserted = session.run(agent, source, source, 'Recorded session', 'resume')
      file.run(source, inserted.lastInsertRowid)
    }
    // Earlier builds had current file cursors but no marker for this parser repair.
    db.prepare('DELETE FROM meta WHERE key = ?').run('opencode_json_parts_files_version')
    db.close()
    db = openSessionSearchDatabase(path)
    expect(db.prepare('SELECT path, byte_offset FROM files ORDER BY path').all()).toEqual([
      { path: '/projects/session.jsonl', byte_offset: 100 },
      { path: '/storage/opencode.db#ses_other', byte_offset: 100 },
      { path: '/storage/session/project/ses_saved.json', byte_offset: -1 }
    ])
    db.prepare('UPDATE files SET byte_offset = 200 WHERE path = ?').run(
      '/storage/session/project/ses_saved.json'
    )
    db.close()
    db = openSessionSearchDatabase(path)
    expect(
      db
        .prepare('SELECT byte_offset FROM files WHERE path = ?')
        .get('/storage/session/project/ses_saved.json')?.byte_offset
    ).toBe(200)
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
