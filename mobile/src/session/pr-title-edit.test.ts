import { describe, expect, it } from 'vitest'
import { buildUpdatePRTitleParams, canEditPRTitle } from './pr-title-edit'

describe('canEditPRTitle', () => {
  it('allows editing on open and draft PRs', () => {
    expect(canEditPRTitle('open')).toBe(true)
    expect(canEditPRTitle('draft')).toBe(true)
  })
  it('disallows editing on closed/merged/unknown', () => {
    expect(canEditPRTitle('closed')).toBe(false)
    expect(canEditPRTitle('merged')).toBe(false)
    expect(canEditPRTitle(null)).toBe(false)
    expect(canEditPRTitle(undefined)).toBe(false)
  })
})

describe('buildUpdatePRTitleParams', () => {
  it('returns null for empty/unchanged drafts (no host round-trip)', () => {
    expect(buildUpdatePRTitleParams(7, '', 'Current')).toBeNull()
    expect(buildUpdatePRTitleParams(7, '   ', 'Current')).toBeNull()
    expect(buildUpdatePRTitleParams(7, '  Current  ', 'Current')).toBeNull()
  })
  it('trims the draft and carries the PR number', () => {
    expect(buildUpdatePRTitleParams(7, '  New title  ', 'Current')).toEqual({
      prNumber: 7,
      title: 'New title'
    })
  })
})
