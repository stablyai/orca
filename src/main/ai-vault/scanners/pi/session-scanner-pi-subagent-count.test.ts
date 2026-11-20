import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from '../../session-scanner'
import { isolatedScanRoots, jsonLines } from '../../scanner-fixtures/session-scanner-test-fixtures'

const PARENT_STEM = '2026-05-01T10-00-00-000Z_cccccccc-dddd-4eee-8fff-000000000000'
const BUCKET = '--repo-app--'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('pi subagent transcript count', () => {
  it('counts the children a Pi parent left under its own stem directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-pi-subagent-count-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const bucketDir = join(roots.piSessionsDir, BUCKET)
    const parentPath = join(bucketDir, `${PARENT_STEM}.jsonl`)
    await mkdir(join(bucketDir, PARENT_STEM, 'd4306da3-ab96-4236-bf98-8865dc4ce978', 'run-0'), {
      recursive: true
    })
    await writeFile(
      parentPath,
      jsonLines([
        {
          type: 'session',
          version: 3,
          id: 'cccccccc-dddd-4eee-8fff-000000000000',
          cwd: '/repo/app'
        },
        { type: 'message', message: { role: 'user', content: 'Delegate the review' } }
      ])
    )
    await writeFile(
      join(
        bucketDir,
        PARENT_STEM,
        'd4306da3-ab96-4236-bf98-8865dc4ce978',
        'run-0',
        'session.jsonl'
      ),
      jsonLines([
        {
          type: 'session',
          version: 3,
          id: '11111111-2222-4333-8444-555555555555',
          cwd: '/repo/app',
          parentSession: parentPath
        },
        { type: 'message', message: { role: 'user', content: 'Review the money paths' } }
      ])
    )

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(
      result.sessions.map((session) => ({
        agent: session.agent,
        filePath: session.filePath,
        subagentTranscriptCount: session.subagentTranscriptCount
      }))
    ).toEqual([{ agent: 'pi', filePath: parentPath, subagentTranscriptCount: 1 }])
  })
})
