import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import {
  claudeUserMessageWasProvablyUnwritten,
  createClaudeUserMessageQueue
} from './claude-agent-sdk-user-message-queue'

/**
 * The SDK's input pump is `for await (const frame of prompt) { await transport.write(frame) }`.
 * A rejected write — or an abort — ends that loop abruptly, which calls the
 * generator's `return()`. Everything below drives that exact shape, because the
 * frame the pump already pulled is the one nothing else can reach.
 */
const frame = (text: string): SDKUserMessage =>
  ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] }
  }) as unknown as SDKUserMessage

const settled = (promise: Promise<void>): Promise<'settled' | 'pending'> =>
  Promise.race([
    promise.then(
      () => 'settled' as const,
      () => 'settled' as const
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100))
  ])

describe('claude user message queue', () => {
  it('treats a frame the SDK pulled and abandoned as write-outcome unknown', async () => {
    const queue = createClaudeUserMessageQueue()
    const pump = queue.messages[Symbol.asyncIterator]()
    const sent = queue.push(frame('hello'))

    await pump.next()
    await pump.return?.(undefined)

    await expect(settled(sent)).resolves.toBe('settled')
    const error = await sent.catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      message: 'claude stream-json input ended before confirming the frame write'
    })
    expect(claudeUserMessageWasProvablyUnwritten(error)).toBe(false)
  })

  it('rejects an in-flight frame from fail() when the SDK never resumes the pump', async () => {
    const queue = createClaudeUserMessageQueue()
    const pump = queue.messages[Symbol.asyncIterator]()
    const sent = queue.push(frame('hello'))

    await pump.next()
    queue.fail(new Error('claude stream-json exited: child died'))

    await expect(settled(sent)).resolves.toBe('settled')
    const error = await sent.catch((caught: unknown) => caught)
    expect(error).toMatchObject({ message: 'claude stream-json exited: child died' })
    expect(claudeUserMessageWasProvablyUnwritten(error)).toBe(false)
  })

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

  it('still settles a written frame only once the pump asks for the next one', async () => {
    const queue = createClaudeUserMessageQueue()
    const pump = queue.messages[Symbol.asyncIterator]()
    const sent = queue.push(frame('hello'))

    const pulled = await pump.next()
    expect(pulled.value).toMatchObject({ type: 'user' })
    // The write proof is the pump coming back for more, exactly as before.
    await expect(settled(sent)).resolves.toBe('pending')
    void pump.next()
    await expect(sent).resolves.toBeUndefined()
  })
})
