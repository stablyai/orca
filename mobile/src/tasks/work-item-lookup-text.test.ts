import { describe, expect, it } from 'vitest'
import { isWorkItemLookupText } from './work-item-lookup-text'

describe('isWorkItemLookupText', () => {
  it('treats references as lookup text, not names', () => {
    expect(isWorkItemLookupText('#42')).toBe(true)
    expect(isWorkItemLookupText('https://github.com/o/r/issues/1')).toBe(true)
    expect(isWorkItemLookupText('https://gitlab.com/g/p/-/merge_requests/2')).toBe(true)
    expect(isWorkItemLookupText('https://linear.app/acme/issue/ENG-9')).toBe(true)
    expect(isWorkItemLookupText('ENG-9')).toBe(false)
  })

  it('treats plain names as non-lookup text', () => {
    expect(isWorkItemLookupText('')).toBe(false)
    expect(isWorkItemLookupText('fix the login bug')).toBe(false)
    expect(isWorkItemLookupText('https://linear.app/acme/project/mobile')).toBe(false)
  })
})
