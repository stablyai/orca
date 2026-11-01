import { describe, expect, it } from 'vitest'
import {
  buildUpdatePRTitleParams,
  canEditPRTitle,
  createPrTitleEditOwnership
} from './pr-title-edit'

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

describe('createPrTitleEditOwnership', () => {
  it('keeps a newer edit open when an older Save succeeds after its deferred reread', async () => {
    const ownership = createPrTitleEditOwnership()
    // First Save's write succeeded; its reread is still pending, so Save has not resolved.
    const firstReread = Promise.withResolvers<boolean>()
    const first = ownership.save(() => firstReread.promise)
    // The user edits again and the newer Save fails.
    ownership.touch()
    await expect(ownership.save(async () => false)).resolves.toBe(false)
    firstReread.resolve(true)
    await expect(first).resolves.toBe(false)
    // With no newer edit, a successful Save still closes the editor.
    await expect(ownership.save(async () => true)).resolves.toBe(true)
  })
})
