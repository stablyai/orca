import { describe, expect, it } from 'vitest'
import { parseTopicGroupAddress, parseTopicList } from './topic-protocol'

describe('orchestration topic protocol', () => {
  it('parses and deduplicates explicit topic lists', () => {
    expect(parseTopicList('["findings","review","findings"]')).toEqual(['findings', 'review'])
  })

  it.each(['[]', '[""]', '["BadCase"]', '["has space"]', '["*"]'])(
    'rejects invalid topic declarations: %s',
    (value) => {
      if (value === '[]') {
        expect(parseTopicList(value)).toEqual([])
        return
      }
      expect(() => parseTopicList(value)).toThrow(/topic/i)
    }
  )

  it('recognizes topic group addresses without changing topic identity', () => {
    expect(parseTopicGroupAddress('@topic:findings')).toBe('findings')
    expect(parseTopicGroupAddress('@topic:review/v2')).toBe('review/v2')
    expect(parseTopicGroupAddress('@all')).toBeUndefined()
  })

  it('rejects malformed topic group addresses', () => {
    expect(() => parseTopicGroupAddress('@topic:')).toThrow(/topic/i)
    expect(() => parseTopicGroupAddress('@topic:BadCase')).toThrow(/topic/i)
  })
})
