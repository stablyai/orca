import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import {
  claudeUserMessageWasProvablyUnwritten,
  createClaudeUserMessageQueue
} from './claude-agent-sdk-user-message-queue'

// Model the SDK pump: it resumes only after transport.write and abandons the iterator on failure.
const frame = (text: string): SDKUserMessage =>
  ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] }
  }) as unknown as SDKUserMessage

describe('claude user message queue', () => {
  it('marks only frames still queued in Orca as provably unwritten', async () => {
    const queue = createClaudeUserMessageQueue()
    const pump = queue.messages[Symbol.asyncIterator]()
    const inFlight = queue.push(frame('first')).catch((caught: unknown) => caught)
    await pump.next()
    const queued = queue.push(frame('second')).catch((caught: unknown) => caught)

    queue.fail(new Error('claude stream-json exited: child died'))

    expect(claudeUserMessageWasProvablyUnwritten(await inFlight)).toBe(false)
    expect(claudeUserMessageWasProvablyUnwritten(await queued)).toBe(true)
  })
})
