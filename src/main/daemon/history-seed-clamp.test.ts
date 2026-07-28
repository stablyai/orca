import { describe, expect, it } from 'vitest'
import { clampHistorySeed } from './history-seed-clamp'
import {
  DAEMON_PTY_HISTORY_SEED_MAX_BYTES,
  daemonRequestAdmissionError
} from './daemon-admission-limits'

describe('clampHistorySeed', () => {
  it('returns the seed unchanged when it already fits', () => {
    expect(clampHistorySeed('[?7h', 'line one\nline two')).toBe('[?7hline one\nline two')
  })

  it('keeps an over-ceiling checkpoint admissible instead of failing the restore', () => {
    // Why: this is the regression — the checkpoint writer can emit far more than the daemon's
    // 12 MiB seed ceiling (the checkpoint read cap is 200 MB), so an unclamped seed made
    // createOrAttach fail and the terminal restored blank. Sized just past the seed cap rather
    // than at the checkpoint ceiling so proving a 12 MiB boundary doesn't allocate 200 MB.
    const oversized = `${'x'.repeat(DAEMON_PTY_HISTORY_SEED_MAX_BYTES + 1024)}\n`
    const seed = clampHistorySeed('[?7h', oversized)

    expect(Buffer.byteLength(seed, 'utf8')).toBeLessThanOrEqual(DAEMON_PTY_HISTORY_SEED_MAX_BYTES)
    expect(
      daemonRequestAdmissionError({
        type: 'request',
        id: 'r1',
        requestType: 'createOrAttach',
        payload: { sessionId: 's1', historySeed: seed }
      })
    ).toBeNull()
  })

  it('preserves the mode-rehydrate prefix and keeps the most recent output', () => {
    const prefix = '[?7h'
    const body = `${'old\n'.repeat(500)}NEWEST-LINE\n`
    const seed = clampHistorySeed(prefix, body, prefix.length + 64)

    expect(seed.startsWith(prefix)).toBe(true)
    expect(seed).toContain('NEWEST-LINE')
    expect(Buffer.byteLength(seed, 'utf8')).toBeLessThanOrEqual(prefix.length + 64)
  })

  it('resumes at a line boundary so the first surviving line is not truncated mid-sequence', () => {
    const body = `${'a'.repeat(100)}\nCOMPLETE-LINE\n`
    const seed = clampHistorySeed('', body, 40)

    expect(seed).toBe('COMPLETE-LINE\n')
  })

  it('yields the body entirely rather than corrupting terminal modes', () => {
    const prefix = '[?7h'
    expect(clampHistorySeed(prefix, 'dropped output', 2)).toBe(prefix)
  })
})
