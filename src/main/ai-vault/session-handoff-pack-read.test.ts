import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host/execution-host'
import { readAiVaultHandoffPack } from './session-handoff-pack-read'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function writeCodexRollout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-handoff-read-'))
  tempRoots.push(root)
  const sessionPath = join(root, 'sessions', '2026', '10', '18', 'rollout-handoff.jsonl')
  await mkdir(dirname(sessionPath), { recursive: true })
  const timestamp = '2026-10-18T10:00:00.000Z'
  await writeFile(
    sessionPath,
    [
      {
        timestamp,
        type: 'session_meta',
        payload: { id: 'handoff-session', history_mode: 'paginated', cwd: '/repo/app' }
      },
      {
        timestamp,
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', content: [{ type: 'text', text: 'wire the widget' }] }
        }
      },
      {
        timestamp,
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'wired it' }] }
        }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
  )
  return sessionPath
}

describe('readAiVaultHandoffPack', () => {
  it('decodes a codex rollout into embedded handoff text', async () => {
    const filePath = await writeCodexRollout()
    const result = await readAiVaultHandoffPack({ agent: 'codex', filePath })
    expect(result.text).toContain('**user**: wire the widget')
    expect(result.text).toContain('**assistant**: wired it')
    expect(result.totalMessages).toBe(2)
    expect(result.truncated).toBe(false)
  })

  it('rejects agents without a transcript decoder', async () => {
    const filePath = await writeCodexRollout()
    await expect(readAiVaultHandoffPack({ agent: 'opencode', filePath })).resolves.toEqual({
      text: null
    })
  })

  it('resolves null for a missing transcript', async () => {
    await expect(
      readAiVaultHandoffPack({ agent: 'codex', filePath: join(tmpdir(), 'orca-no-handoff.jsonl') })
    ).resolves.toEqual({ text: null })
  })

  it('skips non-local execution hosts', async () => {
    const filePath = await writeCodexRollout()
    const remoteHost: ExecutionHostId = 'ssh:test'
    await expect(
      readAiVaultHandoffPack({
        agent: 'codex',
        filePath,
        executionHostId: remoteHost
      })
    ).resolves.toEqual({ text: null })
  })
})
