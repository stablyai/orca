import { describe, expect, it } from 'vitest'
import { resolveMainWindowBlurSurface } from './main-window-blur-surface'

const PLATFORMS: NodeJS.Platform[] = ['darwin', 'win32', 'linux']

describe('resolveMainWindowBlurSurface (#8797)', () => {
  it('keeps the opaque fill and no material when blur is off (#8482 default path)', () => {
    for (const platform of PLATFORMS) {
      expect(resolveMainWindowBlurSurface({ platform, blur: false, dark: true })).toEqual({
        backgroundColor: '#0a0a0a',
        blurOptions: {}
      })
      expect(resolveMainWindowBlurSurface({ platform, blur: false, dark: false })).toEqual({
        backgroundColor: '#ffffff',
        blurOptions: {}
      })
    }
  })

  it('drops the opaque fill so macOS vibrancy is the window backdrop', () => {
    for (const dark of [true, false]) {
      const surface = resolveMainWindowBlurSurface({ platform: 'darwin', blur: true, dark })
      expect(surface.backgroundColor).toBeUndefined()
      expect(surface.blurOptions).toEqual({ vibrancy: 'under-window', visualEffectState: 'active' })
    }
  })

  it('drops the opaque fill so Windows acrylic is visible', () => {
    const surface = resolveMainWindowBlurSurface({ platform: 'win32', blur: true, dark: true })
    expect(surface.backgroundColor).toBeUndefined()
    expect(surface.blurOptions).toEqual({ backgroundMaterial: 'acrylic' })
  })

  it('leaves Linux opaque because it has no supported blur material', () => {
    expect(resolveMainWindowBlurSurface({ platform: 'linux', blur: true, dark: true })).toEqual({
      backgroundColor: '#0a0a0a',
      blurOptions: {}
    })
  })

  it('never requests window transparency (#8482)', () => {
    for (const platform of PLATFORMS) {
      for (const blur of [true, false]) {
        const surface = resolveMainWindowBlurSurface({ platform, blur, dark: true })
        expect(surface.blurOptions).not.toHaveProperty('transparent')
        expect(surface.backgroundColor).not.toBe('#00000000')
      }
    }
  })
})
