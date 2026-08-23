import { describe, expect, it } from 'vitest'
import { orphanedPetEntries, ORPHAN_GRACE_MS } from './pet-orphan-sweep'

const NOW = 1_700_000_000_000
const OLD = NOW - ORPHAN_GRACE_MS - 1
const RECENT = NOW - 1000
const KNOWN = '11111111-2222-3333-4444-555555555555'
const GONE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('orphanedPetEntries', () => {
  it('keeps everything the app still lists', () => {
    const entries = [{ name: KNOWN, mtimeMs: OLD }]

    expect(orphanedPetEntries(entries, new Set([KNOWN]), NOW)).toEqual([])
  })

  it('removes a bundle no pet points at any more', () => {
    const entries = [{ name: GONE, mtimeMs: OLD }]

    expect(orphanedPetEntries(entries, new Set([KNOWN]), NOW)).toEqual([GONE])
  })

  it('removes a legacy image file the same way', () => {
    const entries = [{ name: `${GONE}.png`, mtimeMs: OLD }]

    expect(orphanedPetEntries(entries, new Set([KNOWN]), NOW)).toEqual([`${GONE}.png`])
  })

  it('spares an unknown entry that was only just written', () => {
    // A pet created seconds ago may not have reached the persisted list yet.
    const entries = [{ name: GONE, mtimeMs: RECENT }]

    expect(orphanedPetEntries(entries, new Set(), NOW)).toEqual([])
  })

  it('removes a half-written bundle left by a crash', () => {
    const entries = [{ name: `${KNOWN}.tmp`, mtimeMs: OLD }]

    expect(orphanedPetEntries(entries, new Set([KNOWN]), NOW)).toEqual([`${KNOWN}.tmp`])
  })

  it('leaves alone anything that is not shaped like a pet', () => {
    const entries = [
      { name: 'index.json', mtimeMs: OLD },
      { name: '.DS_Store', mtimeMs: OLD }
    ]

    expect(orphanedPetEntries(entries, new Set(), NOW)).toEqual([])
  })
})
