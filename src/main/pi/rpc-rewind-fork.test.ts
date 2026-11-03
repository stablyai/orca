import { describe, expect, it, vi } from 'vitest'
import { forkPiRpcSessionForRewind } from './rpc-rewind-fork'

const SOURCE = '/host/account/sessions/source.jsonl'
const FORK = '/host/account/sessions/fork.jsonl'

const user = (id: string, parentId: string, content: unknown) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-10-27T10:00:00.000Z',
  message: { role: 'user', content }
})
const answer = (id: string, parentId: string) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-10-27T10:00:01.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text: `answer ${id}` }] }
})
// The abandoned prompt sits on another branch, so it must not count as one the chat removes.
const ENTRIES = [
  { type: 'model_change', id: 'm0', parentId: null, timestamp: '2026-10-27T09:59:59.000Z' },
  user('u1', 'm0', [{ type: 'text', text: 'first' }]),
  answer('a1', 'u1'),
  user('abandoned', 'a1', 'tried in the terminal'),
  user('u2', 'a1', 'second'),
  answer('a2', 'u2'),
  user('u3', 'a2', [
    { type: 'text', text: 'third' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' }
  ]),
  answer('a3', 'u3')
]

function piChild(options: { forks?: boolean; forkReply?: unknown } = {}) {
  let sessionFile = SOURCE
  const request = vi.fn(async (command: string, _params?: Record<string, unknown>) => {
    if (command === 'get_state') {
      return { sessionFile, isStreaming: false, isCompacting: false }
    }
    if (command === 'get_entries') {
      return { entries: ENTRIES, leafId: 'a3' }
    }
    if (command === 'fork') {
      sessionFile = options.forks === false ? SOURCE : FORK
      return 'forkReply' in options ? options.forkReply : { text: 'second', cancelled: false }
    }
    throw new Error(`unexpected ${command}`)
  })
  return { connection: { request }, close: vi.fn(async () => undefined) }
}

describe('Pi rewind fork', () => {
  it("forks with Pi's own fork at the first removed prompt of the active branch", async () => {
    const child = piChild()
    await expect(
      forkPiRpcSessionForRewind(child, { sessionId: SOURCE, prompts: ['second', 'third'] })
    ).resolves.toEqual({
      ok: true,
      fork: {
        sessionId: FORK,
        sourceSessionId: SOURCE,
        throughEntryId: 'a1',
        materialized: true,
        replacesSessionId: SOURCE
      }
    })
    expect(child.connection.request.mock.calls.map(([command]) => command)).toEqual([
      'get_state',
      'get_entries',
      'fork',
      'get_state'
    ])
    expect(child.connection.request).toHaveBeenCalledWith('fork', { entryId: 'u2' })
  })

  it("refuses without forking when Pi's branch does not end with the chat's prompts", async () => {
    for (const prompts of [['first', 'third'], ['zero', 'first', 'second', 'third'], []]) {
      const child = piChild()
      await expect(
        forkPiRpcSessionForRewind(child, { sessionId: SOURCE, prompts })
      ).resolves.toEqual({ ok: false, reason: 'proof-mismatch' })
      expect(child.connection.request).not.toHaveBeenCalledWith('fork', expect.anything())
    }
  })

  it('stops a Pi that did not report its fork, so the next start resumes the recorded chat', async () => {
    const child = piChild({ forks: false })
    await expect(
      forkPiRpcSessionForRewind(child, { sessionId: SOURCE, prompts: ['third'] })
    ).rejects.toThrow('did not report its rewind fork')
    expect(child.close).toHaveBeenCalledOnce()
  })

  it('stops a Pi whose fork reply is unreadable, since Pi may have forked anyway', async () => {
    const child = piChild({ forkReply: { text: 'second' } })
    child.close.mockRejectedValueOnce(new Error('Pi writer killed'))
    await expect(
      forkPiRpcSessionForRewind(child, { sessionId: SOURCE, prompts: ['third'] })
    ).rejects.toThrow('cancelled')
    expect(child.close).toHaveBeenCalledOnce()
  })
})
