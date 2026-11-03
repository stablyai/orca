import { describe, expect, it } from 'vitest'
import { windowMaterialOptions } from './window-material-options'

describe('windowMaterialOptions', () => {
  it('keeps the opaque fill when off', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(windowMaterialOptions('off', platform, '#0a0a0a')).toEqual({
        backgroundColor: '#0a0a0a'
      })
    }
  })

  it('gives each platform a clear window over its material, never transparent vibrancy (#8482, #8797)', () => {
    expect(windowMaterialOptions('blur', 'darwin', '#fff')).toEqual({
      backgroundColor: '#00000000',
      vibrancy: 'under-window',
      visualEffectState: 'active'
    })
    expect(windowMaterialOptions('translucent', 'darwin', '#fff')).toEqual({
      backgroundColor: '#00000000',
      transparent: true
    })
    expect(windowMaterialOptions('blur', 'win32', '#fff')).toEqual({
      backgroundColor: '#00000000',
      backgroundMaterial: 'acrylic'
    })
    expect(windowMaterialOptions('translucent', 'linux', '#fff')).toEqual({
      backgroundColor: '#00000000',
      transparent: true
    })
  })
})
