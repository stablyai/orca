import { describe, expect, it } from 'vitest'
import { resolveWindowGlassPolicy, type WindowGlassEnvironment } from './window-glass-policy'

const environment: WindowGlassEnvironment = {
  platform: 'darwin',
  release: '25.0.0',
  requested: true,
  dark: true,
  reducedTransparency: false,
  highContrast: false,
  softwareRendering: false
}

describe('window glass policy', () => {
  it('uses vibrancy without a transparent window or an opaque renderer fill', () => {
    expect(resolveWindowGlassPolicy(environment)).toEqual({
      available: true,
      options: { vibrancy: 'under-window', visualEffectState: 'followWindow' }
    })
  })
  it.each(['requested', 'reducedTransparency', 'highContrast', 'softwareRendering'] as const)(
    'keeps an opaque backing when %s prevents glass',
    (key) => {
      expect(resolveWindowGlassPolicy({ ...environment, [key]: key !== 'requested' })).toEqual({
        available: false,
        options: { backgroundColor: '#0a0a0a' }
      })
    }
  )
  it.each(['linux', 'freebsd'] as const)('keeps %s opaque', (platform) => {
    expect(resolveWindowGlassPolicy({ ...environment, platform, dark: false })).toEqual({
      available: false,
      options: { backgroundColor: '#ffffff' }
    })
  })
  it.each(['10.0.19045', '10.0.22000', 'invalid'])('does not request acrylic on %s', (release) => {
    expect(resolveWindowGlassPolicy({ ...environment, platform: 'win32', release }).available).toBe(
      false
    )
  })
  it('uncovers acrylic on supported Windows builds', () => {
    expect(
      resolveWindowGlassPolicy({ ...environment, platform: 'win32', release: '10.0.22621' })
    ).toEqual({
      available: true,
      options: { backgroundMaterial: 'acrylic', backgroundColor: '#00000000' }
    })
  })
})
