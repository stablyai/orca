import { describe, expect, it } from 'vitest'
import type { Translate } from '../i18n/mobile-i18n'
import { cloudWakeSlowMessage } from './cloud-wake-slow-message'

const t: Translate = (_key, fallback) => fallback
const QUEUED =
  'Taking longer than usual. Your files are safe. Your prompt sends as soon as it’s awake.'
const PLAIN = 'Taking longer than usual. Your files are safe.'

describe('cloudWakeSlowMessage', () => {
  it('stays quiet through a normal wake and a normal open', () => {
    expect(cloudWakeSlowMessage(9_999, { waking: true, promptQueued: true }, t)).toBeNull()
    // Wake done in about 5 s, access and connect after: a 12 s open is normal.
    expect(cloudWakeSlowMessage(12_000, { waking: false, promptQueued: true }, t)).toBeNull()
    expect(cloudWakeSlowMessage(19_999, { waking: false, promptQueued: false }, t)).toBeNull()
  })

  it('reassures from 10 s of waking, naming the queued prompt only while it still waits on the wake', () => {
    expect(cloudWakeSlowMessage(10_000, { waking: true, promptQueued: true }, t)).toBe(QUEUED)
    expect(cloudWakeSlowMessage(15_000, { waking: true, promptQueued: false }, t)).toBe(PLAIN)
  })

  it('once awake, reassures from 20 s, never saying the prompt waits on the wake', () => {
    expect(cloudWakeSlowMessage(20_000, { waking: false, promptQueued: true }, t)).toBe(PLAIN)
  })

  it('a note already shown stays up after the wake step ends, shortened in place (no blank before 20 s)', () => {
    expect(
      cloudWakeSlowMessage(12_000, { waking: false, promptQueued: true, shownBefore: true }, t)
    ).toBe(PLAIN)
  })
})
