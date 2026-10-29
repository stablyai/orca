import { describe, expect, it } from 'vitest'
import { claudeAccountShortLabel } from './claude-account-short-label'

describe('claudeAccountShortLabel', () => {
  it('uses the mailbox name, and the domain only when two accounts share it', () => {
    const emails = ['ada@example.com', 'ada@work.example', 'grace@example.com']
    expect(claudeAccountShortLabel('ada@example.com', emails)).toBe('ada@example')
    expect(claudeAccountShortLabel('ada@work.example', emails)).toBe('ada@work')
    expect(claudeAccountShortLabel('grace@example.com', emails)).toBe('grace')
    expect(claudeAccountShortLabel('solo', ['solo'])).toBe('solo')
  })
})
