import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots } from './session-scanner-test-fixtures'

const THREAD = '019a1566-3ec8-7bf2-bcb0-71c09cfb4e9d'
const REVERT = '019a1567-0000-7000-8000-000000000001'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

function meta(extra: Record<string, unknown> = {}): string {
  return line({
    timestamp: '2026-06-12T10:00:00.000Z',
    type: 'session_meta',
    payload: { id: THREAD, cwd: '/repo/app', history_mode: 'paginated', ...extra }
  })
}

function message(type: 'UserMessage' | 'AgentMessage', text: string, at: string): string {
  return line({
    timestamp: at,
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type, content: [{ type: 'text', text }] } }
  })
}

describe('a reverted Codex conversation in Session History', () => {
  it('is one row that shows what Codex resumes: inherited prefix, then the current segment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-revert-'))
    tempRoots.push(root)
    const codexHome = join(root, 'codex-home')
    const day = join(codexHome, 'sessions', '2026', '06', '12')
    await mkdir(day, { recursive: true })
    // The original segment, including the turn the user later reverted (BANANA).
    const kept =
      meta() +
      message('UserMessage', 'Remember APPLE', '2026-06-12T10:00:01.000Z') +
      message('AgentMessage', 'OK', '2026-06-12T10:00:02.000Z')
    const original = join(day, `rollout-2026-06-12T10-00-00-${THREAD}.jsonl`)
    await writeFile(
      original,
      kept +
        message('UserMessage', 'Also remember BANANA', '2026-06-12T10:01:00.000Z') +
        message('AgentMessage', 'OK', '2026-06-12T10:01:01.000Z')
    )
    // What thread/revert writes: only a session_meta naming the kept prefix, then new turns.
    const reverted = join(day, `rollout-2026-06-12T10-05-00-${THREAD}_${REVERT}.jsonl`)
    await writeFile(
      reverted,
      meta({
        history_base: {
          thread_id: THREAD,
          end_ordinal_exclusive: 3,
          end_byte_offset: Buffer.byteLength(kept)
        }
      }) +
        message('UserMessage', 'Also remember CHERRY', '2026-06-12T10:05:01.000Z') +
        message('AgentMessage', 'OK', '2026-06-12T10:05:02.000Z')
    )
    const options = {
      ...isolatedScanRoots(root),
      codexSessionsDir: join(codexHome, 'sessions'),
      defaultCodexHomeDir: codexHome,
      unlimited: true
    }

    for (let pass = 0; pass < 2; pass += 1) {
      const rows = (await scanAiVaultSessions(options)).sessions.filter((s) => s.agent === 'codex')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ sessionId: THREAD, filePath: reverted, messageCount: 4 })
      const preview = rows[0].previewMessages?.map((entry) => entry.text).join(' ')
      expect(preview).toContain('APPLE')
      expect(preview).toContain('CHERRY')
      expect(preview).not.toContain('BANANA')
    }

    // Codex's state DB, not the newest file, decides what `codex resume` opens.
    const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)')
    db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(THREAD, original)
    db.close()
    const rows = (await scanAiVaultSessions(options)).sessions.filter((s) => s.agent === 'codex')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ filePath: original, messageCount: 4 })
  })
})
