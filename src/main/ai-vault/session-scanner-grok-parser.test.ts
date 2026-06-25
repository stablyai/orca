import { describe, expect, it, vi } from 'vitest'
import { extractGrokContentText } from './session-scanner-grok-parser'

describe('AI Vault Grok session parser', () => {
  it('extracts bounded user_query text without trimming the full body', () => {
    const trimSpy = vi.spyOn(String.prototype, 'trim')
    const result = extractGrokContentText(
      `<USER_INFO>context</USER_INFO><USER_QUERY>\n${'Grok prompt '.repeat(400)}</USER_QUERY>`
    )
    const trimCalls = trimSpy.mock.calls.length

    expect(trimCalls).toBe(0)
    expect(result?.startsWith('Grok prompt Grok prompt')).toBe(true)
    expect(result?.endsWith('...')).toBe(true)
    expect(result).not.toContain('USER_QUERY')
  })

  it('folds Grok array content without joining all text parts', () => {
    const joinSpy = vi.spyOn(Array.prototype, 'join')
    const result = extractGrokContentText([
      { type: 'text', text: 'Grok array '.repeat(80) },
      { type: 'text', text: 'tail' }
    ])
    const joinCalls = joinSpy.mock.calls.length

    expect(joinCalls).toBe(0)
    expect(result?.startsWith('Grok array Grok array')).toBe(true)
    expect(result?.endsWith('...')).toBe(true)
  })
})
