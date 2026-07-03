import { describe, expect, it, vi } from 'vitest'
import { rovoPartsText } from './session-scanner-graph-parsers'

describe('AI Vault graph session parsers', () => {
  it('folds large Rovo prompt parts without joining the selected text', () => {
    const joinSpy = vi.spyOn(Array.prototype, 'join')
    const result = rovoPartsText(
      [
        { part_kind: 'tool-output', content: 'ignored' },
        { part_kind: 'user-prompt', content: 'Rovo prompt '.repeat(80) },
        { part_kind: 'text', text: 'tail' }
      ],
      'user'
    )
    const joinCalls = joinSpy.mock.calls.length

    expect(joinCalls).toBe(0)
    expect(result?.startsWith('Rovo prompt Rovo prompt')).toBe(true)
    expect(result?.endsWith('...')).toBe(true)
  })
})
