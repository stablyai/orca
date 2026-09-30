import { describe, expect, it } from 'vitest'
import { boundSubagentEntryId, MAX_SUBAGENT_ENTRY_ID_CHARS } from './subagent-entry-id-bounds'

const SHARED_HEAD = 'a'.repeat(MAX_SUBAGENT_ENTRY_ID_CHARS)

describe('boundSubagentEntryId', () => {
  it('leaves an id that already fits untouched', () => {
    const id = 'task-1'
    expect(boundSubagentEntryId(id)).toBe(id)
    expect(boundSubagentEntryId(SHARED_HEAD)).toBe(SHARED_HEAD)
  })

  it('keeps two ids sharing the whole cap-length head distinct', () => {
    const first = boundSubagentEntryId(`${SHARED_HEAD}-one`)
    const second = boundSubagentEntryId(`${SHARED_HEAD}-two`)
    expect(first).not.toBe(second)
    expect(first).toHaveLength(MAX_SUBAGENT_ENTRY_ID_CHARS)
    expect(second).toHaveLength(MAX_SUBAGENT_ENTRY_ID_CHARS)
  })

  it('is deterministic and a no-op on an already bounded id', () => {
    const bounded = boundSubagentEntryId(`${SHARED_HEAD}-one`)
    expect(boundSubagentEntryId(`${SHARED_HEAD}-one`)).toBe(bounded)
    expect(boundSubagentEntryId(bounded)).toBe(bounded)
  })
})
