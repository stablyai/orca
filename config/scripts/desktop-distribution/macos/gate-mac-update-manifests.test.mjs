import { describe, expect, it } from 'vitest'
import { darwinVersionForMacos } from './gate-mac-update-manifests.mjs'

describe('darwinVersionForMacos', () => {
  it('maps whole-major macOS floors to their Darwin floor', () => {
    expect(darwinVersionForMacos('12.0')).toBe('21.0.0')
    expect(darwinVersionForMacos('13')).toBe('22.0.0')
    expect(darwinVersionForMacos('15.0.0')).toBe('24.0.0')
    expect(darwinVersionForMacos('26.0')).toBe('25.0.0')
  })

  it('refuses a minor floor instead of truncating it and offering the update to older Macs', () => {
    expect(() => darwinVersionForMacos('15.4')).toThrow('no exact Darwin floor')
    expect(() => darwinVersionForMacos('13.0.1')).toThrow('no exact Darwin floor')
  })
})
