import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

const tempRoots: string[] = []
afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots.length = 0
})

describe('scanAiVaultSessions user prompt capture', () => {
  it('captures only genuine typed prompts, in order, skipping tool results and injected messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-prompts-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const base = {
      sessionId: 'session-a',
      cwd: '/tmp/claude',
      entrypoint: 'cli'
    }

    await writeJsonlFile(join(roots.claudeProjectsDir, 'project', 'session-a.jsonl'), [
      { type: 'user', ...base, timestamp: '2026-05-01T10:00:00.000Z', message: { role: 'user', content: 'primer prompt real' } },
      { type: 'user', ...base, timestamp: '2026-05-01T10:01:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file output' }] } },
      { type: 'user', ...base, timestamp: '2026-05-01T10:02:00.000Z', isMeta: true, message: { role: 'user', content: 'contexto inyectado' } },
      { type: 'user', ...base, timestamp: '2026-05-01T10:03:00.000Z', message: { role: 'user', content: '--- Orchestration Messages (1) --- From: TERM_X' } },
      { type: 'user', ...base, timestamp: '2026-05-01T10:04:00.000Z', interruptedMessageId: 'm1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      { type: 'assistant', ...base, timestamp: '2026-05-01T10:05:00.000Z', message: { role: 'assistant', content: 'respuesta', model: 'claude' } },
      { type: 'user', ...base, timestamp: '2026-05-01T10:06:00.000Z', message: { role: 'user', content: 'segundo prompt real' } }
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.issues).toEqual([])
    const session = result.sessions.find((s) => s.sessionId === 'session-a')
    expect(session).toBeDefined()
    expect(session?.userPrompts?.map((p) => p.text)).toEqual([
      'primer prompt real',
      'segundo prompt real'
    ])
    expect(session?.userPrompts?.[0]?.timestamp).toBe('2026-05-01T10:00:00.000Z')
  })
})
