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

function messageGraphTranscript(sessionId: string): string {
  return jsonLines([
    { type: 'session', id: sessionId, timestamp: '2026-07-04T04:00:00.000Z', cwd: '/repo/app' },
    {
      type: 'message',
      timestamp: '2026-07-04T04:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: sessionId }] }
    }
  ])
}

async function writeTranscript(filePath: string, sessionId: string): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(filePath, messageGraphTranscript(sessionId))
}

describe('scanAiVaultSessions OpenClaw discovery pruning', () => {
  it('keeps canonical sessions and prunes sibling homes on the local host and WSL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-openclaw-prune-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const wslHome = join(root, 'wsl-home')
    const agentRoots = [
      join(roots.openclawStateDir, 'agents'),
      join(roots.openclawLegacyStateDir, 'agents'),
      join(wslHome, '.openclaw', 'agents'),
      join(wslHome, '.clawdbot', 'agents')
    ]
    const expectedIds: string[] = []
    for (const [index, agentsDir] of agentRoots.entries()) {
      const agentDir = join(agentsDir, 'main')
      expectedIds.push(`direct-${index}`, `nested-${index}`)
      await writeTranscript(join(agentDir, 'sessions', 'direct.jsonl'), `direct-${index}`)
      await writeTranscript(
        join(agentDir, 'sessions', '2026-07', 'nested.jsonl'),
        `nested-${index}`
      )
      // Same shape as the remote fixture: an embedded tool home whose own
      // `sessions` dir would otherwise list as OpenClaw history.
      await writeTranscript(
        join(agentDir, 'agent', 'codex-home', 'sessions', 'embedded.jsonl'),
        `embedded-${index}`
      )
    }

    const result = await scanAiVaultSessions({
      ...roots,
      wslHomeDirs: [wslHome],
      platform: 'win32'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId).sort()).toEqual(expectedIds.sort())
  })

  it('reports a pruned agent directory that holds transcripts outside sessions/', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-openclaw-prune-notice-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const agentsDir = join(roots.openclawLegacyStateDir, 'agents')
    await writeTranscript(join(agentsDir, 'main', 'sessions', 'direct.jsonl'), 'direct')
    await writeTranscript(join(agentsDir, 'relocated', 'archive', 'sessions', 'old.jsonl'), 'old')
    // A fresh agent carries only its runtime dir; that is not a pruned archive.
    await mkdir(join(agentsDir, 'fresh', 'agent'), { recursive: true })

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.sessions.map((session) => session.sessionId)).toEqual(['direct'])
    expect(result.issues).toEqual([
      expect.objectContaining({
        agent: 'openclaw',
        kind: 'notice',
        path: join(agentsDir, 'relocated')
      })
    ])
  })
})
