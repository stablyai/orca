import { describe, expect, it } from 'vitest'
import {
  mobileWebShellPresentationState,
  mobileWebShellShowsNativeChrome
} from './mobile-web-shell-presentation-state'

describe('mobile web shell presentation state', () => {
  it.each([
    [{ hasSelectedHost: false, hasSession: false, packageLoading: false }, 'package-loading'],
    [{ hasSelectedHost: false, hasSession: true, packageLoading: true }, 'package-loading'],
    [{ hasSelectedHost: true, hasSession: true, packageLoading: false }, 'hosted-interface'],
    [{ hasSelectedHost: true, hasSession: true, packageLoading: true }, 'hosted-interface'],
    [{ hasSelectedHost: true, hasSession: false, packageLoading: true }, 'package-loading'],
    [{ hasSelectedHost: true, hasSession: false, packageLoading: false }, 'package-unavailable']
  ] as const)('resolves shell inputs to %s', (inputs, expected) => {
    expect(mobileWebShellPresentationState(inputs)).toBe(expected)
  })

  it('removes prototype shell chrome around the unchanged hosted interface', () => {
    expect(mobileWebShellShowsNativeChrome('hosted-interface')).toBe(false)
    for (const state of ['package-loading', 'package-unavailable'] as const) {
      expect(mobileWebShellShowsNativeChrome(state)).toBe(true)
    }
  })
})
