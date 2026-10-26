import { describe, expect, it } from 'vitest'
import { diffFromText } from '../../../src/shared/native-chat/tools/native-chat-diff'

describe('diffFromText', () => {
  it('caps large diffs before creating render rows', () => {
    const text = Array.from(
      { length: 1_000 },
      (_unused, index) => `${index % 2 === 0 ? '+' : '-'}line-${index}`
    ).join('\n')
    const lines = diffFromText(text)

    expect(lines).toHaveLength(120)
    expect(lines?.at(-1)).toEqual({ kind: 'meta', text: '… diff truncated …' })
  })

  it('honors a smaller caller-owned aggregate row budget', () => {
    const text = Array.from(
      { length: 100 },
      (_unused, index) => `${index % 2 === 0 ? '+' : '-'}line-${index}`
    ).join('\n')

    expect(diffFromText(text, 20)).toHaveLength(20)
  })
})
