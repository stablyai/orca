import { describe, expect, it, vi } from 'vitest'
import { acquired, fakeCodex, THREAD_ID } from './codex-structured-session-adapter-fixture'
import { WORK_INBOX_ROUTING_INSTRUCTIONS } from '../../shared/work-inbox-routing-instructions'
vi.mock('./codex-work-inbox-launch', () => ({
  codexWorkInboxLaunchArgs: () => ['-c', 'inbox-test=true']
}))
describe('explicit native Codex inbox routing', () => {
  it.each([null, THREAD_ID])(
    'adds routing history after opening a thread (resume %s)',
    async (resumeThreadId) => {
      const codex = fakeCodex({ 'thread/inject_items': () => ({}) })
      const adapter = await acquired(codex, {
        env: { ORCA_WORK_INBOX_ROUTING: '1' },
        resumeThreadId
      })
      const calls = codex.connections[0].calls
      expect(calls.find((call) => call.method === 'thread/inject_items')?.params).toEqual({
        threadId: THREAD_ID,
        items: [
          {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: WORK_INBOX_ROUTING_INSTRUCTIONS }]
          }
        ]
      })
      expect(calls.some((call) => call.method === 'turn/start')).toBe(false)
      await adapter.closeSession('session-1')
    }
  )
  it('fails startup when an opted-in provider rejects routing instead of silently dropping it', async () => {
    const codex = fakeCodex({
      'thread/inject_items': () => {
        throw new Error('unsupported method')
      }
    })
    await expect(acquired(codex, { env: { ORCA_WORK_INBOX_ROUTING: '1' } })).rejects.toThrow(
      'unsupported method'
    )
    expect(codex.connections[0].calls.some((call) => call.method === 'turn/start')).toBe(false)
  })
})
