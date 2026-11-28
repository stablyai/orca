import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { scanAiVaultSessions } from '../../session-scanner'
import {
  isolatedScanRoots,
  writeAntigravityHistory,
  writeAntigravityTranscript
} from '../../scanner-fixtures/session-scanner-test-fixtures'
import { readLocalAntigravitySummaryWorkspaces } from './session-scanner-antigravity-summaries-db'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function writeSummariesDb(
  dbPath: string,
  rows: Array<{ conversation_id: string; workspace_uris: string; parent_conversation_id?: string }>
): void {
  const db = new Database(dbPath)
  try {
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        workspace_uris TEXT,
        parent_conversation_id TEXT
      );
    `)
    const insert = db.prepare(
      'INSERT INTO conversation_summaries (conversation_id, workspace_uris, parent_conversation_id) VALUES (?, ?, ?)'
    )
    for (const row of rows) {
      insert.run(row.conversation_id, row.workspace_uris, row.parent_conversation_id ?? '')
    }
  } finally {
    db.close()
  }
}

describe('Antigravity conversation_summaries.db workspace resolution', () => {
  it('resolves Desktop session cwd and inherited subagent cwd when cache JSON and history.jsonl are absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-antigravity-summaries-'))
    tempRoots.push(root)
    const agHome = join(root, '.gemini', 'antigravity')
    const brainDir = join(agHome, 'brain')
    await mkdir(brainDir, { recursive: true })

    const parentId = '8e220c47-d64d-47ab-b2df-a7b448c3b21d'
    const childId = '150a385d-109e-4786-89fb-4b794392eaca'
    const posixId = '933e1de7-0bf0-402d-9ed6-a86f083493f0'

    const record = (text: string, createdAt: string) => [
      {
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        content: `<USER_REQUEST>${text}</USER_REQUEST>`,
        created_at: createdAt
      }
    ]
    await writeAntigravityTranscript(
      brainDir,
      parentId,
      record('parent prompt', '2026-11-26T08:00:00.000Z')
    )
    await writeAntigravityTranscript(
      brainDir,
      childId,
      record('subagent prompt', '2026-11-26T08:01:00.000Z')
    )
    await writeAntigravityTranscript(
      brainDir,
      posixId,
      record('posix prompt', '2026-11-26T08:02:00.000Z')
    )

    writeSummariesDb(join(agHome, 'conversation_summaries.db'), [
      {
        conversation_id: parentId,
        workspace_uris: JSON.stringify(['file:///d%3A/%E6%A1%8C%E9%9D%A2'])
      },
      {
        conversation_id: childId,
        workspace_uris: '',
        parent_conversation_id: parentId
      },
      {
        conversation_id: posixId,
        workspace_uris: JSON.stringify(['file:///Users/ada/work'])
      }
    ])

    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(root),
      antigravityAppHome: root,
      includeAntigravityIdeSessions: true
    })

    const byId = new Map(result.sessions.map((session) => [session.sessionId, session.cwd]))
    expect(byId.get(parentId)).toBe('d:\\桌面')
    expect(byId.get(childId)).toBe('d:\\桌面')
    expect(byId.get(posixId)).toBe('/Users/ada/work')
  })

  it('prefers history.jsonl workspace over conversation_summaries.db when both exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-antigravity-summaries-precedence-'))
    tempRoots.push(root)
    const agHome = join(root, '.gemini', 'antigravity-cli')
    const brainDir = join(agHome, 'brain')
    await mkdir(brainDir, { recursive: true })

    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    await writeAntigravityTranscript(brainDir, sessionId, [
      {
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        content: '<USER_REQUEST>hello</USER_REQUEST>',
        created_at: '2026-11-26T08:00:00.000Z'
      }
    ])
    await writeAntigravityHistory(brainDir, [
      {
        conversationId: sessionId,
        display: 'hello',
        workspace: '/canonical/workspace',
        timestamp: '2026-11-26T08:00:00.000Z'
      }
    ])
    writeSummariesDb(join(agHome, 'conversation_summaries.db'), [
      {
        conversation_id: sessionId,
        workspace_uris: JSON.stringify(['file:///fallback/workspace'])
      }
    ])

    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(root),
      antigravityBrainDir: brainDir
    })

    expect(result.sessions).toEqual([
      expect.objectContaining({
        sessionId,
        cwd: '/canonical/workspace'
      })
    ])
  })

  it('handles parent cycles, missing databases, and corrupt databases gracefully', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-antigravity-summaries-edge-'))
    tempRoots.push(root)

    expect(await readLocalAntigravitySummaryWorkspaces(join(root, 'missing.db'))).toEqual(new Map())

    const corruptPath = join(root, 'corrupt.db')
    await writeFile(corruptPath, 'not-sqlite')
    expect(await readLocalAntigravitySummaryWorkspaces(corruptPath)).toEqual(new Map())

    const cyclePath = join(root, 'cycle.db')
    writeSummariesDb(cyclePath, [
      { conversation_id: 'a', workspace_uris: '', parent_conversation_id: 'b' },
      { conversation_id: 'b', workspace_uris: '', parent_conversation_id: 'a' }
    ])
    expect(await readLocalAntigravitySummaryWorkspaces(cyclePath)).toEqual(new Map())
  })

  it('does not inherit parent workspace when a child explicitly lists multiple workspaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-antigravity-summaries-multi-'))
    tempRoots.push(root)
    const dbPath = join(root, 'conversation_summaries.db')
    writeSummariesDb(dbPath, [
      {
        conversation_id: 'parent',
        workspace_uris: JSON.stringify(['file:///parent'])
      },
      {
        conversation_id: 'child-empty-array',
        workspace_uris: '[]',
        parent_conversation_id: 'parent'
      },
      {
        conversation_id: 'child-multi',
        workspace_uris: JSON.stringify(['file:///child-a', 'file:///child-b']),
        parent_conversation_id: 'parent'
      }
    ])

    const resolved = await readLocalAntigravitySummaryWorkspaces(dbPath)
    expect(resolved.get('parent')).toBe('/parent')
    expect(resolved.get('child-empty-array')).toBe('/parent')
    expect(resolved.has('child-multi')).toBe(false)
  })
})
