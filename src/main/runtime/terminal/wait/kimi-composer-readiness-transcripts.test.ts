import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from '../../../../shared/agent-launch/startup/readiness/draft-paste-ready-scanner'
import { readTimedRuntimeFixture } from './agent-transcript-replay-test-harness'

/** kimi-code 2.6.2 cold boot: bracketed paste on, then the trust dialog, then the composer. */
const KIMI_BOOT = 'kimi-2-6-2-cold-boot'
/** Byte 22, t=1878. Arms the quiet window 36ms before the trust dialog paints. */
const BRACKETED_PASTE_CHUNK = 2
/** The chunk whose composer input row makes the signal ready. */
const COMPOSER_CHUNK = 10

describe('kimi captured composer readiness', () => {
  it('takes the composer row, not the silence around the trust dialog', () => {
    const { chunks, times } = readTimedRuntimeFixture(KIMI_BOOT)
    const scanner = createDraftPasteReadyScanner('kimi-composer-prompt')

    // Why replay chunk by chunk: readiness is a property of the stream, so a chunk that
    // arrives early must not claim a composer a later chunk has not drawn yet.
    const readyAt = chunks.findIndex((chunk) => scanner.observe(chunk).ready)

    expect(readyAt).toBe(COMPOSER_CHUNK)
    expect(times[COMPOSER_CHUNK]).toBe(1937)
  })

  it('stays unready while the trust dialog is the only thing on screen', () => {
    const { chunks } = readTimedRuntimeFixture(KIMI_BOOT)
    const scanner = createDraftPasteReadyScanner('kimi-composer-prompt')

    // The trust dialog paints at chunk 8 and the composer replaces it at chunk 10, so
    // every chunk before 10 must report not-ready or the draft lands in the dialog.
    const beforeComposer = chunks.slice(0, COMPOSER_CHUNK).map((chunk) => scanner.observe(chunk))

    expect(beforeComposer.some((result) => result.ready)).toBe(false)
  })

  it('arms the quiet window the old signal used before the trust dialog paints', () => {
    const { chunks, times } = readTimedRuntimeFixture(KIMI_BOOT)
    const scanner = createDraftPasteReadyScanner('render-quiet-after-bracketed-paste')

    const armedAt = chunks.findIndex((chunk) => scanner.observe(chunk).armQuietTimer)
    const trustDialogAt = chunks.findIndex((chunk) => chunk.includes('Trust this folder'))

    // Why this stays: the removed signal armed on ?2004h, 36ms before the dialog paints.
    // A capture whose dialog sat long enough to go quiet for 1500ms would drop the draft,
    // which is the failure this signal replaces rather than a case it happens to also pass.
    expect(armedAt).toBe(BRACKETED_PASTE_CHUNK)
    expect(times[armedAt]).toBe(1878)
    expect(trustDialogAt).toBeGreaterThan(armedAt)
  })
})
