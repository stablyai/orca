import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { createClaudeUserMessageQueue } from './claude-agent-sdk-user-message-queue'

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
  it('rejects the frame the SDK pulled but abandoned without writing', async () => {
    const queue = createClaudeUserMessageQueue()
    const pump = queue.messages[Symbol.asyncIterator]()
    const sent = queue.push(frame('hello'))

    await pump.next()
    await pump.return?.(undefined)

    await expect(settled(sent)).resolves.toBe('settled')
    await expect(sent).rejects.toThrow(
      'claude stream-json input ended before the frame was written'
    )
  })

  it('rejects an in-flight frame from fail() when the SDK never resumes the pump', async () => {
    const queue = createClaudeUserMessageQueue()
    const pump = queue.messages[Symbol.asyncIterator]()
    const sent = queue.push(frame('hello'))

    await pump.next()
    queue.fail(new Error('claude stream-json exited: child died'))

    await expect(settled(sent)).resolves.toBe('settled')
    await expect(sent).rejects.toThrow('claude stream-json exited: child died')
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
