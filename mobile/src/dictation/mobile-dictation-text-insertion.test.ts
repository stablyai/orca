import { describe, expect, it } from 'vitest'
import { insertDictationText } from './mobile-dictation-text-insertion'

const at = (text: string, start: number, end = start) => ({ text, start, end })

describe('insertDictationText', () => {
  it('spaces dictation away from the words around the caret at the start, middle and end', () => {
    const draft = 'update the tests'
    expect(insertDictationText(draft, 'Please', at(draft, 0))).toEqual({
      text: 'Please update the tests',
      caret: 6
    })
    expect(insertDictationText(draft, 'all', at(draft, 11)).text).toBe('update the all tests')
    expect(insertDictationText(draft, 'now', at(draft, draft.length)).text).toBe(
      'update the tests now'
    )
    expect(insertDictationText('Done.', 'Next', at('Done.', 5)).text).toBe('Done. Next')
  })

  it('replaces the selected words and keeps the caret after them', () => {
    const draft = 'Rename the prop and update the tests'
    expect(insertDictationText(draft, 'fetchTimeout', at(draft, 7, 15))).toEqual({
      text: 'Rename fetchTimeout and update the tests',
      caret: 19
    })
  })

  it('adds no space inside quotes, before punctuation or around CJK', () => {
    const command = "git commit -m ''"
    expect(insertDictationText(command, 'log retry', at(command, 15)).text).toBe(
      "git commit -m 'log retry'"
    )
    expect(insertDictationText('git commit -m "', 'fix it', null).text).toBe(
      'git commit -m "fix it'
    )
    expect(insertDictationText('He said “”', 'hello', at('He said “”', 9)).text).toBe(
      'He said “hello”'
    )
    expect(insertDictationText('hello', ', world', at('hello', 5)).text).toBe('hello, world')
    expect(insertDictationText('你好', '世界', at('你好', 2)).text).toBe('你好世界')
  })

  it('spaces dictation after closing quotes, brackets and symbols', () => {
    for (const draft of [
      'echo "hi"',
      'see (this)',
      'Look at `foo`',
      'ls -la |',
      'done 🎉',
      "fix James'"
    ]) {
      expect(insertDictationText(draft, 'and more', null).text).toBe(`${draft} and more`)
    }
  })

  it('tells apostrophes from quote marks', () => {
    const quoted = "it's 'quoted'"
    expect(insertDictationText(quoted, 'really', at(quoted, 5)).text).toBe("it's really 'quoted'")
    const inner = "don't touch 'x'"
    expect(insertDictationText(inner, 'y', at(inner, 14)).text).toBe("don't touch 'x y'")
  })

  it('appends when the field was never focused or changed since the selection was read', () => {
    expect(insertDictationText('ls -la', 'in src', null).text).toBe('ls -la in src')
    expect(insertDictationText('', 'spoken', null).text).toBe('spoken')
    expect(insertDictationText('ls -la src', 'now', at('ls -la', 0)).text).toBe('ls -la src now')
  })
})
