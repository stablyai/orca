import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from '../../session-scanner'
import { isolatedScanRoots, jsonLines } from '../../scanner-fixtures/session-scanner-test-fixtures'

const SESSION_STEM = '2026-05-01T10-00-00-000Z_cccccccc-dddd-4eee-8fff-000000000000'
const SESSION_ID = 'cccccccc-dddd-4eee-8fff-000000000000'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions OMP subagent pruning', () => {
  it('prunes artifact transcripts without pruning a workspace named like a session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-omp-prune-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const workspaceDir = join(roots.ompSessionsDir, SESSION_STEM)
    const artifactDir = join(workspaceDir, SESSION_STEM)
    await mkdir(artifactDir, { recursive: true })

    await writeFile(
      join(workspaceDir, `${SESSION_STEM}.jsonl`),
      jsonLines([
        {
          type: 'session',
          version: 3,
          id: SESSION_ID,
          cwd: '/repo/app',
          timestamp: '2026-05-01T10:00:00.000Z'
        },
        {
          type: 'message',
          timestamp: '2026-05-01T10:00:01.000Z',
          message: { role: 'user', content: 'Delegate some tasks' }
        }
      ])
    )
    await writeFile(
      join(artifactDir, 'AuthAndPreflight.jsonl'),
      jsonLines([
        {
          type: 'session',
          version: 3,
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-222222222222',
          cwd: '/repo/app',
          timestamp: '2026-05-01T10:01:00.000Z'
        },
        {
          type: 'message',
          timestamp: '2026-05-01T10:01:01.000Z',
          message: { role: 'user', content: 'Subagent task prompt' }
        }
      ])
    )

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      sessionId: SESSION_ID,
      subagentTranscriptCount: 1
    })
  })

  it('picks up a task transcript written after the coordinator last changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-omp-late-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const workspaceDir = join(roots.ompSessionsDir, 'home-app-85dfa2f0')
    await mkdir(workspaceDir, { recursive: true })
    // No further parent writes: only cached-reuse recount can discover a late child.
    await writeFile(
      join(workspaceDir, `${SESSION_STEM}.jsonl`),
      jsonLines([
        {
          type: 'session',
          version: 3,
          id: SESSION_ID,
          cwd: '/repo/app',
          timestamp: '2026-05-01T10:00:00.000Z'
        }
      ])
    )

    const first = await scanAiVaultSessions({ ...roots, platform: 'darwin' })
    expect(first.sessions.find((entry) => entry.sessionId === SESSION_ID)).toMatchObject({
      messageCount: 0,
      subagentTranscriptCount: 0
    })

    await mkdir(join(workspaceDir, SESSION_STEM), { recursive: true })
    await writeFile(
      join(workspaceDir, SESSION_STEM, 'AuthAndPreflight.jsonl'),
      jsonLines([
        {
          type: 'message',
          timestamp: '2026-05-01T10:01:01.000Z',
          message: { role: 'user', content: 'Late task prompt' }
        }
      ])
    )

    const second = await scanAiVaultSessions({ ...roots, platform: 'darwin' })
    expect(
      second.sessions.find((entry) => entry.sessionId === SESSION_ID)?.subagentTranscriptCount
    ).toBe(1)
  })
})
