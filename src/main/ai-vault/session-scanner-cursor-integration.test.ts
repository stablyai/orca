import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { cursorBucketForCwd, cursorLegacySlug } from './session-scanner-cursor-paths'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Cursor session scanner integration', () => {
  it('attributes a cwd-less sidecar to an exact folder-workspace scope and merges legacy data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-integration-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const workspace = join(root, 'folder-workspace')
    const sessionId = 'opaque-session'
    const bucket = cursorBucketForCwd(workspace, 'linux')
    const sessionDir = join(roots.cursorChatsDir, bucket, sessionId)
    const transcriptPath = join(
      roots.cursorProjectsDir,
      cursorLegacySlug(workspace),
      'agent-transcripts',
      sessionId,
      `${sessionId}.jsonl`
    )
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(sessionDir, { recursive: true }),
      mkdir(join(transcriptPath, '..'), { recursive: true })
    ])
    await Promise.all([
      writeFile(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          createdAtMs: 1_750_000_000_000,
          updatedAtMs: 1_750_000_001_000,
          hasConversation: true,
          title: 'Scoped Cursor session'
        })
      ),
      writeFile(join(sessionDir, 'store.db'), ''),
      writeFile(
        transcriptPath,
        jsonLines([
          { role: 'user', message: { content: [{ type: 'text', text: 'Legacy prompt' }] } },
          { role: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } }
        ])
      )
    ])

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'linux',
      executionHostId: 'local',
      scopePaths: [workspace],
      limit: 1
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      id: `local:cursor:${sessionId}`,
      cwd: workspace,
      filePath: join(sessionDir, 'meta.json'),
      transcriptFilePath: transcriptPath,
      title: 'Scoped Cursor session',
      messageCount: 2,
      hasConversation: true
    })
  })

  it('backfills only the matching bucket when one session id collides across buckets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-collision-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const scopePath = join(root, 'scoped-workspace')
    // Timestamps derive from array index, so the newest bucket must sort last.
    const otherPaths = [join(root, 'middle-workspace'), join(root, 'newest-workspace')]
    const sessionId = 'shared-session-id'
    await mkdir(scopePath, { recursive: true })

    const sessionPaths = await Promise.all(
      [scopePath, ...otherPaths].map(async (cwd, index) => {
        const sessionDir = join(roots.cursorChatsDir, cursorBucketForCwd(cwd, 'linux'), sessionId)
        await mkdir(sessionDir, { recursive: true })
        await Promise.all([
          writeFile(
            join(sessionDir, 'meta.json'),
            JSON.stringify({
              createdAtMs: 1_750_000_000_000 + index,
              updatedAtMs: 1_750_000_001_000 + index,
              hasConversation: true,
              title: `Collision ${index}`
            })
          ),
          writeFile(join(sessionDir, 'store.db'), '')
        ])
        return join(sessionDir, 'meta.json')
      })
    )

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'linux',
      executionHostId: 'local',
      scopePaths: [scopePath],
      limit: 1
    })

    expect(result.sessions.map((session) => session.filePath).sort()).toEqual(
      [sessionPaths[0], sessionPaths[2]].sort()
    )
  })
})
