import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ AccessibilityInfo: {}, Platform: { OS: 'ios' }, Text: 'Text' }))
vi.mock('../i18n/use-mobile-translation', () => ({ useMobileTranslation: () => undefined }))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => undefined }))
vi.mock('./cloud-workspace-screen-styles', () => ({ cloudWorkspaceScreenStyles: {} }))

import type { Translate } from '../i18n/mobile-i18n'
import { cloudWakeSlowMessage } from './CloudWakeSlowNote'

const t: Translate = (_key, fallback) => fallback

describe('cloudWakeSlowMessage', () => {
  it('stays quiet through a normal wake and a normal open', () => {
    expect(cloudWakeSlowMessage(9_000, { waking: true, promptQueued: true }, t)).toBeNull()
    // Wake done in about 5 s, access and connect after: a 12 s open is normal.
    expect(cloudWakeSlowMessage(12_000, { waking: false, promptQueued: true }, t)).toBeNull()
  })

  it('reassures past 10 s of waking, naming the queued prompt only while it is still waiting on the wake', () => {
    expect(cloudWakeSlowMessage(10_000, { waking: true, promptQueued: true }, t)).toBe(
      'Taking longer than usual. Your files are safe. Your prompt sends as soon as it’s awake.'
    )
    expect(cloudWakeSlowMessage(11_000, { waking: true, promptQueued: false }, t)).toBe(
      'Taking longer than usual. Your files are safe.'
    )
  })

  it('once awake, reassures only past 20 s, and never says the prompt waits on the wake', () => {
    expect(cloudWakeSlowMessage(21_000, { waking: false, promptQueued: true }, t)).toBe(
      'Taking longer than usual. Your files are safe.'
    )
  })
})
