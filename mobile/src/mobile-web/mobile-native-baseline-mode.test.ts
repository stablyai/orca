import { describe, expect, it } from 'vitest'
import { mobileHybridRouteRetired, mobileNativeBaselineMode } from './mobile-native-baseline-mode'

describe('mobile native baseline mode', () => {
  it('allows the exact runner flag in a development build', () => {
    expect(mobileNativeBaselineMode({ developmentBuild: true, requested: '1' })).toBe(true)
    expect(mobileNativeBaselineMode({ developmentBuild: true, requested: undefined })).toBe(false)
    expect(mobileNativeBaselineMode({ developmentBuild: true, requested: 'true' })).toBe(false)
  })

  it('defaults release builds to native and development builds to hybrid', () => {
    expect(mobileNativeBaselineMode({ developmentBuild: false, requested: undefined })).toBe(true)
    expect(mobileNativeBaselineMode({ developmentBuild: true, requested: undefined })).toBe(false)
  })

  it('opts release builds into hybrid architecture explicitly', () => {
    expect(
      mobileNativeBaselineMode({
        developmentBuild: false,
        requested: undefined,
        architecture: 'hybrid'
      })
    ).toBe(false)
    expect(
      mobileNativeBaselineMode({
        developmentBuild: false,
        requested: undefined,
        architecture: 'native'
      })
    ).toBe(true)
  })

  // Why the hybrid arm: without an explicit architecture a release build defaults to native, so
  // that case passes with the developmentBuild guard deleted. Only a release build that opted
  // into hybrid can show the flag being refused.
  it('does not allow the development baseline flag in production', () => {
    expect(mobileNativeBaselineMode({ developmentBuild: false, requested: '1' })).toBe(true)
    expect(
      mobileNativeBaselineMode({
        developmentBuild: false,
        requested: '1',
        architecture: 'hybrid'
      })
    ).toBe(false)
    expect(
      mobileNativeBaselineMode({ developmentBuild: true, requested: '1', architecture: 'hybrid' })
    ).toBe(true)
  })

  // The hosted E2E runner enables native baselines and then opens /hybrid in the same bundle, so
  // the baseline flag must never retire the hybrid route.
  it('keeps /hybrid reachable in a development build regardless of the baseline flag', () => {
    expect(mobileHybridRouteRetired({ developmentBuild: true })).toBe(false)
    expect(mobileHybridRouteRetired({ developmentBuild: true, architecture: 'hybrid' })).toBe(false)
    expect(mobileHybridRouteRetired({ developmentBuild: true, architecture: 'native' })).toBe(true)
  })

  it('retires /hybrid in release builds unless the hybrid architecture is explicit', () => {
    expect(mobileHybridRouteRetired({ developmentBuild: false })).toBe(true)
    expect(mobileHybridRouteRetired({ developmentBuild: false, architecture: 'hybrid' })).toBe(
      false
    )
    expect(mobileHybridRouteRetired({ developmentBuild: false, architecture: 'native' })).toBe(true)
  })
})
