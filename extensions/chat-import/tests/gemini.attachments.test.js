// tests/gemini.attachments.test.js
import { test, expect } from 'vitest'
import { scanGeminiImages } from '../lib/normalize.js'

test('scanGeminiImages collects googleusercontent images with adjacent filename', () => {
  const raw = [
    null,
    [
      [null, 1, 'icon.png', 'https://lh3.googleusercontent.com/gg/AAA111'],
      [null, [null, '14897855006095834265.jpeg', 'https://lh3.googleusercontent.com/gg/BBB222']]
    ]
  ]
  const out = scanGeminiImages(raw)
  expect(out.length).toBe(2)
  expect(out[0].name).toBe('icon.png')
  expect(out[0].url.endsWith('/gg/AAA111')).toBeTruthy()
  expect(out[1].name).toBe('14897855006095834265.jpeg')
})

test('scanGeminiImages dedups repeated URLs and ignores non-/gg/ and avatars', () => {
  const raw = [
    ['x.png', 'https://lh3.googleusercontent.com/gg/SAME'],
    ['y.png', 'https://lh3.googleusercontent.com/gg/SAME'], // dup URL
    ['https://lh3.googleusercontent.com/a/avatar'] // avatar (no /gg/)
  ]
  const out = scanGeminiImages(raw)
  expect(out.length).toBe(1)
  expect(out[0].url.endsWith('/gg/SAME')).toBeTruthy()
})

test('scanGeminiImages returns [] for non-array / empty', () => {
  expect(scanGeminiImages(undefined)).toEqual([])
  expect(scanGeminiImages([])).toEqual([])
})
