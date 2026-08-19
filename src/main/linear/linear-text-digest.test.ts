import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LINEAR_PROJECT_ENTITY_OUTPUT_CAP } from '../../shared/linear/project-agent-access'
import {
  boundedLinearEntityCollection,
  boundedLinearNullableString,
  boundedLinearString,
  linearSha256Hex,
  normalizeLinearLineEndings
} from './linear-text-digest'

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

describe('linear text digests', () => {
  it('normalizes CRLF and lone CR to LF without trimming', () => {
    expect(normalizeLinearLineEndings(' a\r\nb\rc\n ')).toBe(' a\nb\nc\n ')
  })

  it('hashes UTF-8 bytes as lowercase hex', () => {
    const digest = linearSha256Hex('héllo')
    expect(digest).toBe(sha256('héllo'))
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('computes chars and digest over the complete value before capping', () => {
    const bounded = boundedLinearString('abcdef', 3)
    expect(bounded).toEqual({
      value: 'abc',
      truncated: true,
      chars: 6,
      sha256: sha256('abcdef')
    })
  })

  it('digests the normalized text, not the raw line endings', () => {
    expect(boundedLinearString('a\r\nb').sha256).toBe(sha256('a\nb'))
    expect(boundedLinearString('a\r\nb').chars).toBe(3)
  })

  it('marks an exactly-capped value as untruncated', () => {
    expect(boundedLinearString('abc', 3)).toMatchObject({ value: 'abc', truncated: false })
  })

  it('distinguishes a null value from an empty string', () => {
    expect(boundedLinearNullableString(null)).toEqual({
      value: null,
      truncated: false,
      chars: 0,
      sha256: ''
    })
    expect(boundedLinearNullableString('')).toEqual({
      value: '',
      truncated: false,
      chars: 0,
      sha256: sha256('')
    })
  })

  it('dedupes by id, sorts lexicographically and caps items after counting', () => {
    const collection = boundedLinearEntityCollection(
      [{ id: 'c' }, { id: 'a' }, { id: 'b' }, { id: 'a' }],
      2
    )
    expect(collection.items).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(collection).toMatchObject({ returned: 2, total: 3, truncated: true })
    expect(collection.sha256).toBe(sha256(JSON.stringify(['a', 'b', 'c'])))
  })

  it('keeps the digest stable regardless of input order', () => {
    const forward = boundedLinearEntityCollection([{ id: 'x' }, { id: 'y' }])
    const reverse = boundedLinearEntityCollection([{ id: 'y' }, { id: 'x' }])
    expect(forward.sha256).toBe(reverse.sha256)
    expect(forward.truncated).toBe(false)
  })

  it('defaults to the shared entity output cap', () => {
    const items = Array.from({ length: LINEAR_PROJECT_ENTITY_OUTPUT_CAP + 5 }, (_, index) => ({
      id: `id-${String(index).padStart(4, '0')}`
    }))
    const collection = boundedLinearEntityCollection(items)
    expect(collection.returned).toBe(LINEAR_PROJECT_ENTITY_OUTPUT_CAP)
    expect(collection.total).toBe(items.length)
    expect(collection.truncated).toBe(true)
  })
})
