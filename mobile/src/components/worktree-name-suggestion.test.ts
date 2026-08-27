import { describe, expect, it } from 'vitest'
import { MARINE_CREATURES } from '../../../src/shared/marine-creatures'
import { getSuggestedCreatureName } from './worktree-name-suggestion'

const pickFirst = () => 0
const lower = (index: number) => MARINE_CREATURES[index].toLowerCase()
const retiring = (...names: string[]) => ({ exhaustedTiers: 0, names })

describe('getSuggestedCreatureName (mobile)', () => {
  it('picks an unused name', () => {
    expect(getSuggestedCreatureName([], pickFirst)).toBe(lower(0))
  })

  it('dedupes against the basename of a live worktree path', () => {
    expect(getSuggestedCreatureName([`/home/u/worktrees/${MARINE_CREATURES[0]}`], pickFirst)).toBe(
      lower(1)
    )
  })

  it('handles Windows separators and trailing separators like the desktop does', () => {
    expect(getSuggestedCreatureName(['C:\\worktrees\\Nautilus\\\\'], pickFirst)).not.toBe(
      'nautilus'
    )
  })

  it('never reissues a retired name whose workspace is already deleted', () => {
    // Parity with desktop: the deleted workspace's directory may still hold agent
    // conversation state keyed by cwd, so the name must not come back.
    expect(getSuggestedCreatureName([], pickFirst, retiring(MARINE_CREATURES[0]))).toBe(lower(1))
  })

  it('treats retired names case-insensitively', () => {
    expect(
      getSuggestedCreatureName([], pickFirst, retiring(MARINE_CREATURES[0].toUpperCase()))
    ).toBe(lower(1))
  })

  it('applies retirement on top of live paths rather than instead of them', () => {
    expect(
      getSuggestedCreatureName(
        [`/home/u/worktrees/${MARINE_CREATURES[0]}`],
        pickFirst,
        retiring(MARINE_CREATURES[1])
      )
    ).toBe(lower(2))
  })

  it('degrades to a suffixed tier when the pool is spent, skipping retired variants', () => {
    const allPaths = MARINE_CREATURES.map((name) => `/home/u/worktrees/${name}`)
    expect(getSuggestedCreatureName(allPaths, pickFirst, retiring(`${lower(0)}-2`))).toBe(
      `${lower(1)}-2`
    )
  })

  it('skips every tier the host reports as compacted rather than looking its names up', () => {
    // Those names are absent from the wire payload because they are ALL spent, not available.
    expect(getSuggestedCreatureName([], pickFirst, { exhaustedTiers: 2, names: [] })).toBe(
      `${lower(0)}-3`
    )
  })

  it('falls back to live-only dedupe when the host sends no retired names', () => {
    // Hosts predating the wire field omit it; behavior must match the pre-change app.
    expect(getSuggestedCreatureName([`/home/u/worktrees/${MARINE_CREATURES[0]}`], pickFirst)).toBe(
      lower(1)
    )
  })
})
