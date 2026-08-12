import { describe, expect, it } from 'vitest'
import { mobileMonoFontFamily as defaultMonoFontFamily } from './mobile-mono-font-family'
import { mobileMonoFontFamily as iosMonoFontFamily } from './mobile-mono-font-family.ios'

describe('mobile monospace font family', () => {
  it('uses the native monospaced system design on iOS', () => {
    expect(iosMonoFontFamily).toBe('ui-monospace')
  })

  it('keeps the generic monospace family on other platforms', () => {
    expect(defaultMonoFontFamily).toBe('monospace')
  })
})
