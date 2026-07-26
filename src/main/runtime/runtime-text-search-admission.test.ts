import { describe, expect, it } from 'vitest'
import { assertRuntimeTextSearchAdmission } from './runtime-text-search-admission'

describe('assertRuntimeTextSearchAdmission', () => {
  it('allows ordinary and replacement searches but rejects excess distinct roots', () => {
    const active = new Map<string, unknown>([
      ['repo-a', {}],
      ['repo-b', {}]
    ])

    expect(() => assertRuntimeTextSearchAdmission(active, 'repo-a', 2)).not.toThrow()
    expect(() => assertRuntimeTextSearchAdmission(active, 'repo-c', 2)).toThrow('search is busy')
  })
})
