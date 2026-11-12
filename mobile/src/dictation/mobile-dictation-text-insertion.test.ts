import { describe, expect, it } from 'vitest'
import { insertDictationText } from './mobile-dictation-text-insertion'

const at = (text: string, start: number, end = start) => ({ text, start, end })

describe('insertDictationText', () => {
  it('appends when the field was never focused or changed since the selection was read', () => {
    expect(insertDictationText('ls -la', 'in src', null).text).toBe('ls -la in src')
    expect(insertDictationText('', 'spoken', null).text).toBe('spoken')
    expect(insertDictationText('ls -la src', 'now', at('ls -la', 0)).text).toBe('ls -la src now')
  })
})
