import { describe, expect, it } from 'vitest'
import { liveTypingSteps } from './use-mobile-browser-live-typing'

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// Chromium's Backspace: a whole emoji cluster, otherwise the last code point. Text is typed at the end.
function applyToPage(page: string, previous: string, next: string): string {
  let result = page
  for (const step of liveTypingSteps(previous, next)) {
    if ('text' in step) {
      result += step.text
    } else if ('key' in step) {
      const last = Array.from(graphemes.segment(result)).at(-1)?.segment ?? ''
      result = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(last)
        ? result.slice(0, result.length - last.length)
        : Array.from(result).slice(0, -1).join('')
    }
  }
  return result
}

describe('liveTypingSteps', () => {
  it('leaves the page holding exactly what the field holds, without touching text typed before', () => {
    const before = 'name: '
    const edits = [
      '',
      'h',
      'hi',
      'hi ',
      'hi 👍🏽',
      'hi 👍🏻',
      'hi ',
      'hi ❤️',
      'hi ❤',
      'hey ❤',
      'नमस्ते',
      'नम',
      'é',
      'e',
      '👨‍👩‍👧',
      '👨‍👩',
      '🇬🇭',
      ''
    ]
    for (let index = 1; index < edits.length; index += 1) {
      const previous = edits[index - 1]
      const next = edits[index]
      expect(applyToPage(before + previous, previous, next)).toBe(before + next)
    }
  })
})
