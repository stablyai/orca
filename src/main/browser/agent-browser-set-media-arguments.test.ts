import { describe, expect, it } from 'vitest'
import { agentBrowserSetMediaArguments } from './agent-browser-set-media-arguments'

describe('agentBrowserSetMediaArguments', () => {
  it.each([
    [undefined, 'reduce', ['set', 'media', 'reduced-motion']],
    [undefined, 'no-preference', ['set', 'media']],
    ['dark', undefined, ['set', 'media', 'dark']],
    ['light', 'reduce', ['set', 'media', 'light', 'reduced-motion']]
  ])('maps color scheme %s and reduced motion %s', (colorScheme, reducedMotion, expected) => {
    expect(agentBrowserSetMediaArguments(colorScheme, reducedMotion)).toEqual(expected)
  })

  it.each([
    ['sepia', undefined, 'Unsupported --color-scheme: sepia (expected dark or light)'],
    [
      undefined,
      'reduced-motion',
      'Unsupported --reduced-motion: reduced-motion (expected reduce or no-preference)'
    ]
  ])('rejects color scheme %s and reduced motion %s', (colorScheme, reducedMotion, message) => {
    expect(() => agentBrowserSetMediaArguments(colorScheme, reducedMotion)).toThrow(
      expect.objectContaining({ code: 'invalid_argument', message })
    )
  })
})
