import { expect, it } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listCodexChildSessions } from './session-scanner-codex-children'
it('discovers exact physical child edges dated from the parent on, keeping duplicate labels distinct', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-recorded-children-'))
  const P = '11111111-1111-4111-8111-111111111111',
    A = '22222222-2222-4222-8222-222222222222',
    B = '33333333-3333-4333-8333-333333333333',
    earlierDay = '44444444-4444-4444-8444-444444444444',
    earlierYear = '55555555-5555-4555-8555-555555555555'
  const meta = (id: string, parent?: string) =>
    `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id,
        cwd: '/folder',
        source: parent
          ? { subagent: { thread_spawn: { parent_thread_id: parent, agent_nickname: 'Twin' } } }
          : 'cli'
      }
    })}\n`
  const rollout = async (day: string, id: string, parent?: string) => {
    const directory = join(root, ...day.split('-'))
    await mkdir(directory, { recursive: true })
    const path = join(directory, `rollout-${day}T10-00-00-${id}.jsonl`)
    await writeFile(path, meta(id, parent))
    return path
  }
  try {
    const parent = await rollout('2026-03-02', P)
    await rollout('2026-03-03', A, P)
    await rollout('2026-03-02', B, P)
    await rollout('2026-03-01', earlierDay, P)
    await rollout('2025-12-31', earlierYear, P)
    await writeFile(join(root, '2026', '03', '03', 'wrong-physical-id.jsonl'), meta(A, P))
    await writeFile(join(root, '2026', '03', '03', 'sibling.jsonl'), meta(B, 'other-parent'))
    const result = await listCodexChildSessions({ parentFilePath: parent, sessionsRoot: root })
    expect(result.issues).toEqual([])
    expect(result.sessions.map((row) => row.sessionId).sort()).toEqual([A, B])
    expect(result.sessions.map((row) => row.title)).toEqual(['Twin', 'Twin'])
    expect(result.sessions.every((row) => row.subagent?.parentSessionId === P)).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
