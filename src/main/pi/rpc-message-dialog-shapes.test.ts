import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PiRpcMessages } from './rpc-messages'
import { PiRpcContextUsage } from './rpc-context-usage'
import { piRpcDialogPresentation } from './rpc-extension-dialogs'

describe('recorded Pi message and extension shapes', () => {
  it('keeps tool image results as native attachments while retaining text output', () => {
    const messages = new PiRpcMessages('images', new PiRpcContextUsage())
    const events = messages.tool({
      type: 'tool_execution_end',
      toolCallId: 'screenshot',
      toolName: 'read',
      result: {
        content: [
          { type: 'text', text: 'Screenshot' },
          { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }
        ]
      }
    })
    expect(events).toMatchObject([
      { body: { kind: 'tool-call', state: 'completed', output: { head: 'Screenshot' } } },
      {
        body: {
          kind: 'message',
          role: 'tool',
          blocks: [{ type: 'image-ref', url: 'data:image/png;base64,aW1hZ2U=' }]
        }
      }
    ])
    expect(JSON.stringify(events[0])).not.toContain('aW1hZ2U=')
  })
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

  it('leaves the answer hint to the card when Pi sends an empty placeholder', () => {
    // Captured from @juicesharp/rpiv-ask-user-question 2.13.8's "Type something." follow-up on Pi 1.2.0.
    const dialog = piRpcDialogPresentation({
      type: 'extension_ui_request',
      id: 'ff1e0726-9fe9-4dfd-8d58-3e64a0f84160',
      method: 'input',
      title: '[Repro] Which color?\n\n1. Red — warm\n2. Blue — cool\n\nType your answer:',
      placeholder: ''
    })
    expect(dialog?.body).toHaveProperty('freeTextInput', { allowEmpty: true })
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

  it('keeps native select descriptions without changing the value returned to the extension', () => {
    const dialog = piRpcDialogPresentation({
      id: 'select-description',
      method: 'select',
      title: 'Choose an environment',
      options: ['staging', 'production'],
      optionDetails: [{ description: 'Safe test environment' }, {}]
    })
    expect(dialog?.body).toMatchObject({
      options: [
        { id: 'option-0', label: 'staging', description: 'Safe test environment' },
        { id: 'option-1', label: 'production' }
      ]
    })
    expect(
      dialog?.reply({ kind: 'answers', answers: [{ questionId: 'q1', optionIds: ['option-0'] }] })
    ).toEqual({ value: 'staging' })
  })
})
