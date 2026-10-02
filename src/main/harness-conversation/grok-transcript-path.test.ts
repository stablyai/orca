import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { findGrokChatHistoryBySessionId } from '../../shared/grok-session-paths'
import { publishGrokTranscriptPath } from './grok-transcript-path'
import type * as GrokSessionPaths from '../../shared/grok-session-paths'

vi.mock('../../shared/grok-session-paths', async (original) => ({
  ...(await original<typeof GrokSessionPaths>()),
  findGrokChatHistoryBySessionId: vi.fn()
}))

it('uses the spawned driver home and tolerates absent or unreadable optional history', async () => {
  const sink = { setTranscriptPath: vi.fn() }
  vi.mocked(findGrokChatHistoryBySessionId).mockResolvedValue(
    '/custom/grok/group/session/chat_history.jsonl'
  )
  await publishGrokTranscriptPath(
    { env: { HOME: '/pinned-home', GROK_HOME: '/custom/grok' }, sink },
    'session'
  )
  expect(findGrokChatHistoryBySessionId).toHaveBeenLastCalledWith(
    join('/custom/grok', 'sessions'),
    'session'
  )
  expect(sink.setTranscriptPath).toHaveBeenLastCalledWith(
    '/custom/grok/group/session/chat_history.jsonl'
  )
  vi.mocked(findGrokChatHistoryBySessionId).mockRejectedValue(new Error('unavailable'))
  await expect(
    publishGrokTranscriptPath({ env: { HOME: '/pinned-home' }, sink }, 'session')
  ).resolves.toBeUndefined()
  expect(findGrokChatHistoryBySessionId).toHaveBeenLastCalledWith(
    join('/pinned-home', '.grok', 'sessions'),
    'session'
  )
  expect(sink.setTranscriptPath).toHaveBeenCalledTimes(1)
})
