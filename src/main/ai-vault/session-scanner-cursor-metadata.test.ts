import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

describe('Cursor session metadata', () => {
  const rootsToRemove: string[] = []

  afterEach(async () => {
    await Promise.all(rootsToRemove.splice(0).map((root) => rm(root, { recursive: true })))
  })

  it('joins chat metadata to transcripts across workspaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-metadata-'))
    rootsToRemove.push(root)
    const roots = isolatedScanRoots(root)
    const sessionId = '6542b450-4fdf-4899-bb8e-e8f6a220dd53'
    const transcriptDir = join(
      roots.cursorProjectsDir,
      'f-codexFile-cursor',
      'agent-transcripts',
      sessionId
    )
    const metadataDir = join(roots.cursorChatsDir, 'workspace-md5', sessionId)
    await Promise.all([
      mkdir(transcriptDir, { recursive: true }),
      mkdir(metadataDir, { recursive: true })
    ])
    await writeFile(
      join(transcriptDir, `${sessionId}.jsonl`),
      jsonLines([
        { role: 'user', message: { content: [{ type: 'text', text: '你好' }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: '已恢复' }] } }
      ])
    )
    await writeFile(
      join(metadataDir, 'meta.json'),
      JSON.stringify({
        schemaVersion: 1,
        createdAtMs: Date.parse('2026-08-14T04:00:00.000Z'),
        updatedAtMs: Date.parse('2026-08-14T04:05:00.000Z'),
        hasConversation: true,
        cwd: 'F:\\codexFile\\cursor反代'
      })
    )

    const result = await scanAiVaultSessions({ ...roots, platform: 'win32' })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      agent: 'cursor',
      sessionId,
      title: '你好',
      cwd: 'F:\\codexFile\\cursor反代',
      createdAt: '2026-08-14T04:00:00.000Z',
      updatedAt: '2026-08-14T04:05:00.000Z',
      resumeCommand:
        'cmd /d /s /c "cd /d ""F:\\codexFile\\cursor反代"" && cursor-agent --resume ""6542b450-4fdf-4899-bb8e-e8f6a220dd53"""'
    })
  })
})
