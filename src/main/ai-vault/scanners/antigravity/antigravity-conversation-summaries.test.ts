import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../../sqlite/sync-database'
import { firstWorkspacePath } from './antigravity-conversation-summaries'
import { scanAiVaultSessions } from '../../session-scanner'
import { isolatedScanRoots, writeAntigravityTranscript } from '../../session-scanner-test-fixtures'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

function writeSummariesDb(dbPath: string, rows: { id: string; workspaceUris: string }[]): void {
  const db = new SyncDatabase(dbPath)
  try {
    db.exec(
      'CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT "", workspace_uris text NOT NULL)'
    )
    const insert = db.prepare(
      'INSERT INTO conversation_summaries (conversation_id, workspace_uris) VALUES (?, ?)'
    )
    for (const row of rows) {
      insert.run(row.id, row.workspaceUris)
    }
  } finally {
    db.close()
  }
}

describe('Antigravity conversation_summaries.db workspaces', () => {
  it('resolves cwd for conversations that history.jsonl never recorded and overrides cache conflicts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-agy-summaries-'))
    temporaryDirectories.push(home)
    const brain = join(home, '.gemini', 'antigravity-cli', 'brain')
    const workspace = join(home, 'projects', 'orca')
    const records = (prompt: string) => [
      {
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-11-07T17:00:00Z',
        content: `<USER_REQUEST>${prompt}</USER_REQUEST>`
      }
    ]
    await writeAntigravityTranscript(brain, 'summary-only', records('Only the database knows'))
    await writeAntigravityTranscript(brain, 'conflicted', records('Cache disagrees'))
    await writeAntigravityTranscript(brain, 'unknown', records('Nobody recorded this'))
    const cache = join(dirname(brain), 'cache')
    await mkdir(cache, { recursive: true })
    await writeFile(
      join(cache, 'last_conversations.json'),
      JSON.stringify({ [join(home, 'stale')]: 'conflicted' })
    )
    writeSummariesDb(join(dirname(brain), 'conversation_summaries.db'), [
      { id: 'summary-only', workspaceUris: JSON.stringify([pathToFileURL(workspace).href]) },
      { id: 'conflicted', workspaceUris: JSON.stringify([pathToFileURL(workspace).href]) }
    ])

    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(home),
      antigravityBrainDir: brain
    })

    const cwdById = new Map(result.sessions.map((session) => [session.sessionId, session.cwd]))
    expect(cwdById.get('summary-only')).toBe(workspace)
    expect(cwdById.get('conflicted')).toBe(workspace)
    expect(cwdById.get('unknown')).toBeNull()
  })

  it('ignores a summaries database without the expected table', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-agy-summaries-'))
    temporaryDirectories.push(home)
    const brain = join(home, '.gemini', 'antigravity-cli', 'brain')
    await writeAntigravityTranscript(brain, 'plain', [
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>hi</USER_REQUEST>' }
    ])
    const db = new SyncDatabase(join(dirname(brain), 'conversation_summaries.db'))
    db.exec('CREATE TABLE unrelated (id text)')
    db.close()

    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(home),
      antigravityBrainDir: brain
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.cwd)).toEqual([null])
  })

  it('takes the first local file URI and skips other schemes', () => {
    const local = join(tmpdir(), 'workspace')
    expect(
      firstWorkspacePath(JSON.stringify(['vscode-remote://ssh/x', pathToFileURL(local).href]))
    ).toBe(local)
    expect(firstWorkspacePath('not json')).toBeNull()
    expect(firstWorkspacePath(JSON.stringify({}))).toBeNull()
  })
})
