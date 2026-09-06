import { describe, expect, it } from 'vitest'
import { sanitizeMobileWebNativeChatToolInput } from './mobile-web-native-chat-tool-input'

describe('mobile web native chat tool input', () => {
  it('preserves supported tool input used by the existing mobile UI', () => {
    const input = {
      questions: [
        {
          question: 'Pick one',
          options: [
            { label: 'Alpha', description: 'First option' },
            { label: 'Beta', description: 'Second option' }
          ]
        }
      ]
    }

    expect(sanitizeMobileWebNativeChatToolInput(input)).toEqual(input)
  })

  it('bounds depth, collection width, keys, strings, and cycles', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const input = {
      deep: { one: { two: { three: { four: { five: 'hidden' } } } } },
      wide: Array.from({ length: 40 }, (_unused, index) => index),
      cyclic,
      [`${'k'.repeat(128)}A`]: 'first',
      [`${'k'.repeat(128)}B`]: 'second',
      long: 'x'.repeat(8_000)
    }

    const result = sanitizeMobileWebNativeChatToolInput(input)
    const encoded = JSON.stringify(result)

    expect(encoded.length).toBeLessThan(8_000)
    expect(encoded).toContain('truncated')
    expect(encoded).not.toContain('hidden')
    expect(Object.keys(result as Record<string, unknown>)).toHaveLength(6)
  })
})
