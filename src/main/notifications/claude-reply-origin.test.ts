import { afterEach, describe, expect, it } from 'vitest'
import { isClaudeHumanReply } from './claude-reply-origin'
import { createReplyTranscriptFixture } from './claude-reply-origin.test-fixture'

const { transcript, dispose } = createReplyTranscriptFixture()
afterEach(dispose)

describe('Claude exact prompt origin', () => {
  it('S10: recovers a human origin across a compact summary and a large tail', async () => {
    const path = await transcript([
      { type: 'user', promptId: 'A', origin: { kind: 'human' } },
      { type: 'assistant', message: { content: 'x'.repeat(150_000) } },
      { type: 'user', promptId: 'A', isCompactSummary: true }
    ])
    expect(await isClaudeHumanReply(path, 'A')).toBe(true)
  })
  it('S4/S11: neither summaries, unrelated people, nor task notifications imply human origin', async () => {
    const path = await transcript([
      { type: 'user', promptId: 'A', origin: { kind: 'human' } },
      { type: 'user', promptId: 'B', origin: { kind: 'task-notification' } },
      { type: 'user', promptId: 'B', isCompactSummary: true }
    ])
    expect(await isClaudeHumanReply(path, 'B')).toBe(false)
    expect(await isClaudeHumanReply(path, 'missing')).toBe(false)
  })
  it('stops at the matching explicit origin and fails closed on cancellation', async () => {
    const path = await transcript([
      { type: 'assistant', message: { content: 'x'.repeat(150_000) } },
      { type: 'user', promptId: 'A', origin: { kind: 'human' } }
    ])
    let bytes = 0
    expect(
      await isClaudeHumanReply(path, 'A', undefined, (read) => {
        bytes += read
      })
    ).toBe(true)
    expect(bytes).toBeLessThan(150_000)
    const controller = new AbortController()
    controller.abort()
    expect(await isClaudeHumanReply(path, 'A', controller.signal)).toBe(false)
  })
  it('stops at the preceding turn when the current prompt has no explicit origin', async () => {
    const path = await transcript([
      { type: 'assistant', message: { content: 'x'.repeat(150_000) } },
      { type: 'user', promptId: 'A', origin: { kind: 'human' } },
      { type: 'user', promptId: 'B', origin: null },
      { type: 'assistant', promptId: 'B' }
    ])
    let bytes = 0
    expect(await isClaudeHumanReply(path, 'B', undefined, (read) => (bytes += read))).toBe(false)
    expect(bytes).toBeLessThan(150_000)
  })
  it.each(['human', 'task-notification'])(
    'uses the latest explicit user origin when Claude reuses a prompt ID: %s',
    async (kind) => {
      const path = await transcript([
        {
          type: 'user',
          promptId: 'P',
          origin: { kind: kind === 'human' ? 'task-notification' : 'human' }
        },
        { type: 'user', promptId: 'P', origin: { kind } }
      ])
      expect(await isClaudeHumanReply(path, 'P')).toBe(kind === 'human')
    }
  )
  it('S1: reads past origin-less user tool results to the human prompt', async () => {
    const path = await transcript([
      { type: 'user', promptId: 'P', origin: { kind: 'human' } },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'invented-tool', name: 'Read', input: {} }] }
      },
      {
        type: 'user',
        promptId: 'P',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'invented-tool', content: 'invented result' }
          ]
        }
      },
      { type: 'assistant', message: { stop_reason: 'end_turn', content: 'invented reply' } }
    ])
    expect(await isClaudeHumanReply(path, 'P')).toBe(true)
  })
})
