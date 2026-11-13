import { describe, expect, it } from 'vitest'
import { insertDictationText } from './mobile-dictation-text-insertion'

const at = (text: string, start: number, end = start) => ({ text, start, end })

describe('insertDictationText', () => {
  it('appends after the current draft when its captured selection is stale', () => {
    expect(insertDictationText('ls -la src', 'now', at('ls -la', 0)).text).toBe('ls -la src now')
  })
})
