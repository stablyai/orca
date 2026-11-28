import { describe, expect, it } from 'vitest'
import { chat, fakeCodex, launch } from './codex-shared-server-pool-fixture'

const CLOSE_RPCS = new Set([
  'thread/backgroundTerminals/list',
  'thread/backgroundTerminals/clean',
  'thread/unsubscribe'
])

async function closeRpcsAfterResume(historyHelpers: number): Promise<number> {
  const { servers, pool } = fakeCodex()
  const conn = await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
  // A second chat keeps the server up, so the close stops only this chat's work.
  await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
  await conn.request('thread/resume', { threadId: 'parent', historyHelpers })
  const before = servers[0]!.requests.length
  await conn.close()
  return servers[0]!.requests.slice(before).filter((r) => CLOSE_RPCS.has(r.method)).length
}

describe('shared Codex chat close', () => {
  it('sends nothing for helpers named only in history', async () => {
    const atN = await closeRpcsAfterResume(50)
    expect(atN).toBe(2)
    expect(await closeRpcsAfterResume(500)).toBe(atN)
  })
})
