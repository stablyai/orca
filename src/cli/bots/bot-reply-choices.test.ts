import { describe, expect, it } from 'vitest'
import { readReplyChoices } from './bot-reply-choices'

// Repeated flags arrive joined, as the CLI's parser hands them over.
const flags = (entries: Record<string, string | string[]>) =>
  new Map<string, string | boolean>(
    Object.entries(entries).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join('\u0000') : value
    ])
  )

describe('orca bot reply --choice', () => {
  it('reads each label, trimmed, with the text they answer', () => {
    expect(readReplyChoices(flags({ text: 'Ship it?', choice: [' Yes ', 'Not yet'] }))).toEqual([
      'Yes',
      'Not yet'
    ])
    expect(readReplyChoices(flags({ text: 'Ship it?' }))).toBeUndefined()
  })

  it('refuses choices it could not post, before anything goes', () => {
    const refusal = (entries: Record<string, string | string[]>) => {
      try {
        readReplyChoices(flags(entries))
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }
    expect(refusal({ choice: ['Yes'] })).toMatch(/needs --text/)
    expect(refusal({ text: 'Q', choice: ['Yes'], file: 'a.png' })).toMatch(/without --file/)
    expect(refusal({ text: 'Q', choice: ['Yes'], note: 'a.ts:1:x' })).toMatch(/--note/)
    expect(refusal({ text: 'Q', choice: Array.from({ length: 11 }, (_, i) => `C${i}`) })).toMatch(
      /up to 10 choices/
    )
    expect(refusal({ text: 'Q', choice: ['   '] })).toMatch(/needs a label/)
    expect(refusal({ text: 'Q', choice: ['x'.repeat(76)] })).toMatch(/75 characters/)
    expect(refusal({ text: 'Q', choice: ['Yes', ' Yes'] })).toMatch(/once/)
    expect(refusal({ text: 'Q', choice: Array.from({ length: 10 }, (_, i) => `C${i}`) })).toBe(null)
    expect(refusal({ text: 'Q', choice: ['x'.repeat(75)] })).toBe(null)
  })
})
