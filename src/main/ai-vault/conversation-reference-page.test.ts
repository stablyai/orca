import { describe, expect, it } from 'vitest'
import { collectConversationReferencePage } from './conversation-reference-page'

const reference = 'orca-conversation://reference/12345678-1234-4234-8234-123456789abc?host=local'
const messages = [
  { role: 'user' as const, text: 'alpha '.repeat(10000), timestamp: null },
  { role: 'assistant' as const, text: 'TARGET answer', timestamp: null },
  { role: 'assistant' as const, text: 'other answer', timestamp: null }
]

describe('conversation reference pages', () => {
  it('reads a long message over successive pages without losing text', () => {
    let cursor: string | undefined
    const output: string[] = []
    do {
      const page = collectConversationReferencePage('ref', 'version', {
        reference,
        ...(cursor ? { cursor } : {})
      })
      messages.forEach(page.push)
      const result = page.finish()
      expect(result.messages.map((message) => message.text).join('').length).toBeLessThanOrEqual(
        24 * 1024
      )
      output.push(...result.messages.map((message) => message.text))
      cursor = result.nextCursor ?? undefined
    } while (cursor)
    expect(output.join('')).toBe(messages.map((message) => message.text).join(''))
  })

  it('searches only matching messages and binds continuation to the source and query', () => {
    const context = collectConversationReferencePage('ref', 'version', {
      reference,
      fromMessage: 1
    })
    messages.forEach(context.push)
    expect(context.finish().messages.map((message) => message.text)).toEqual([
      'TARGET answer',
      'other answer'
    ])
    const page = collectConversationReferencePage('ref', 'version', { reference, query: 'target' })
    messages.forEach(page.push)
    expect(page.finish().messages.map((message) => message.text)).toEqual(['TARGET answer'])
    const first = collectConversationReferencePage('ref', 'version', { reference, limit: 1 })
    messages.forEach(first.push)
    const cursor = first.finish().nextCursor!
    expect(() => collectConversationReferencePage('ref', 'changed', { reference, cursor })).toThrow(
      'changed'
    )
    expect(() =>
      collectConversationReferencePage('ref', 'version', { reference, cursor, query: 'other' })
    ).toThrow('changed')
    expect(() =>
      collectConversationReferencePage('another-ref', 'version', { reference, cursor })
    ).toThrow('changed')
  })

  it('resets replaced provider arrays and reports unavailable source text', () => {
    const page = collectConversationReferencePage('ref', 'version', { reference })
    page.push(messages[0]!)
    page.reset()
    page.push({ ...messages[1]!, textTruncated: true })
    expect(page.finish().messages.map((message) => message.text)).toEqual(['TARGET answer'])
    expect(page.finish().warnings).toHaveLength(1)
  })
})
