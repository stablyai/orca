import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PiRpcMessages } from './rpc-messages'
import { PiRpcContextUsage } from './rpc-context-usage'
import { piRpcDialogPresentation } from './rpc-extension-dialogs'

describe('recorded Pi message and extension shapes', () => {
  it('publishes top-level live usage before the assistant message ends', () => {
    const frameSchema = z.looseObject({
      type: z.string(),
      usage: z
        .object({
          input: z.number(),
          output: z.number(),
          cacheRead: z.number(),
          cacheWrite: z.number()
        })
        .optional()
    })
    const frames = readFileSync(
      join(import.meta.dirname, '__fixtures__', 'steer-followup.jsonl'),
      'utf8'
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const envelope = z.object({ raw: z.string() }).parse(JSON.parse(line))
        return frameSchema.parse(JSON.parse(envelope.raw))
      })
    const update = frames.find(
      (frame) =>
        frame.type === 'message_update' &&
        frame.usage &&
        Object.values(frame.usage).some((tokens) => tokens > 0)
    )
    expect(update).toBeDefined()
    const messages = new PiRpcMessages('generation', new PiRpcContextUsage())
    expect(messages.message(update, 123)).toContainEqual({
      type: 'context.usage',
      usage: {
        used: {
          kind: 'estimate',
          usage: {
            inputTokens: update?.usage?.input,
            outputTokens: update?.usage?.output,
            cacheCreationInputTokens: update?.usage?.cacheWrite,
            cacheReadInputTokens: update?.usage?.cacheRead
          },
          capturedAt: 123
        }
      }
    })
  })

  it.each(['input', 'editor', 'select'])('preserves the provider message for %s', (method) => {
    const dialog = piRpcDialogPresentation({
      id: 'dialog',
      method,
      title: 'Choose',
      message: 'Use staging',
      options: ['value']
    })
    expect(dialog?.body).toMatchObject({ kind: 'question', question: 'Choose\n\nUse staging' })
  })

  it('labels an empty select value while delivering its original string', () => {
    const dialog = piRpcDialogPresentation({
      id: 'select',
      method: 'select',
      title: 'Choose',
      options: ['']
    })
    expect(dialog?.body).toMatchObject({ options: [{ id: 'option-0', label: 'Empty value' }] })
    expect(
      dialog?.reply({ kind: 'answers', answers: [{ questionId: 'q1', optionIds: ['option-0'] }] })
    ).toEqual({ value: '' })
  })
})
