import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions Claude subagent pruning', () => {
  it('prunes subagents/ transcripts instead of listing them as sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-subagent-prune-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const subagentsDir = join(roots.claudeProjectsDir, 'project', 'claude-session', 'subagents')
    await mkdir(subagentsDir, { recursive: true })

    await writeFile(
      join(roots.claudeProjectsDir, 'project', 'claude-session.jsonl'),
      jsonLines([
        {
          type: 'user',
          sessionId: 'claude-session',
          timestamp: '2026-05-01T10:00:00.000Z',
          cwd: '/repo/app',
          message: { role: 'user', content: 'Spawn a Task' }
        }
      ])
    )
    await writeFile(
      join(subagentsDir, 'agent-abc123.jsonl'),
      jsonLines([
        {
          type: 'user',
          sessionId: 'claude-session',
          isSidechain: true,
          agentId: 'abc123',
          timestamp: '2026-05-01T10:01:00.000Z',
          cwd: '/repo/app',
          message: { role: 'user', content: 'Subagent task prompt' }
        }
      ])
    )

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.issues).toEqual([])
    // Only the parent session surfaces; the subagent transcript is not a row,
    // but it is still counted for the row's "N subagents" affordance.
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      sessionId: 'claude-session',
      subagentTranscriptCount: 1
    })
  })
})
