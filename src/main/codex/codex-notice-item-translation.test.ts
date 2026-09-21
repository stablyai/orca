import { describe, expect, it } from 'vitest'
import { codexItemBody, codexStreamingJournalItem } from './codex-structured-item-translation'
import { AgentJournalItemBodySchema } from '../../shared/agent-session-journal-schemas'
import { projectStructuredItemsToNativeChat } from '../../shared/structured-agent-session-projection'

describe('plan document translation', () => {
  it('marks both complete documents and streaming snapshots', () => {
    const item = { id: 'plan-1', type: 'plan', text: '# Plan\n\nReadable prose.' }
    expect(codexItemBody(item)).toEqual({
      kind: 'status',
      text: item.text,
      presentation: 'plan-document'
    })
    expect(codexStreamingJournalItem(item, '# Plan\n\nPartial').body).toEqual({
      kind: 'status',
      text: '# Plan\n\nPartial',
      presentation: 'plan-document'
    })
    expect(codexItemBody({ id: 'plan-1', type: 'plan' })).toBeNull()
  })
  it('preserves the full existing reasoning body byte for byte', () => {
    expect(
      codexItemBody({ id: 'r', type: 'reasoning', summary: ['Thinking through the problem.'] })
    ).toEqual({
      kind: 'status',
      text: 'Thinking through the problem.'
    })
    expect(codexStreamingJournalItem({ id: 'r', type: 'reasoning' }, 'Thinking…')).toEqual({
      body: { kind: 'status', text: 'Thinking…' },
      handled: true
    })
  })
})

describe('image item translation', () => {
  it.each(['/remote/work/image.png', 'C:\\work\\image.png'])(
    'preserves the execution-host path %s and old-reader operation text',
    (path) => {
      expect(codexItemBody({ id: 'view', type: 'imageView', path })).toEqual({
        kind: 'message',
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'Viewed image' },
          { type: 'image-ref', path }
        ]
      })
    }
  )
  it('prefers saved paths over unbounded inline image data', () => {
    const body = codexItemBody({
      id: 'gen',
      type: 'imageGeneration',
      status: 'completed',
      savedPath: '/remote/image.png',
      result: 'A'.repeat(100_000)
    })
    expect(body).toEqual({
      kind: 'message',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Generated image' },
        { type: 'image-ref', path: '/remote/image.png' }
      ]
    })
    expect(AgentJournalItemBodySchema.safeParse(body).success).toBe(true)
    const [message] = projectStructuredItemsToNativeChat([
      { itemId: 'gen', revision: 1, sequence: 1, observedAt: 1, body: body! }
    ])
    expect(message?.blocks).toEqual(body?.kind === 'message' ? body.blocks : [])
  })
  it.each(['AAAA', 'data:image/png;base64,AAAA'])(
    'maps bounded image data onto a meaningful existing image-ref: %s',
    (result) => {
      expect(
        codexItemBody({ id: 'gen', type: 'imageGeneration', status: 'completed', result })
      ).toMatchObject({
        kind: 'message',
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'Generated image' },
          { type: 'image-ref', url: 'data:image/png;base64,AAAA', alt: 'Generated image' }
        ]
      })
    }
  )
  it.each(['A'.repeat(20_000), 'not valid image bytes', 'data:text/html;base64,AAAA', ''])(
    'keeps unavailable results bounded and readable',
    (result) => {
      const body = codexItemBody({
        id: 'gen',
        type: 'imageGeneration',
        status: 'completed',
        result
      })
      expect(body).toEqual({
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Image generated: preview unavailable' }]
      })
    }
  )
  it.each([
    [{ status: 'inProgress' }, 'Generating image…'],
    [{ status: 'failed' }, 'Image generation failed'],
    [{ status: 'completed', failure: { type: 'usageLimitExceeded' } }, 'Image generation failed'],
    [{ status: 'future-state' }, 'Image generation: preview unavailable']
  ])('does not invent completed output for %j', (fields, text) => {
    expect(codexItemBody({ id: 'gen', type: 'imageGeneration', ...fields })).toEqual({
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text }]
    })
  })
})
