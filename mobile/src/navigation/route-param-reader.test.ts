import { describe, expect, it } from 'vitest'
import { readWorkspaceRouteExecutionHost } from './route-param-reader'

describe('readWorkspaceRouteExecutionHost', () => {
  it.each(['runtime:wsl:ubuntu-22.04', 'runtime:wsl%3Aubuntu-22.04'])(
    'matches the desktop catalog for %s',
    (value) => {
      expect(readWorkspaceRouteExecutionHost(value)).toBe('runtime:wsl%3Aubuntu-22.04')
    }
  )

  it.each([
    ['local', 'local'],
    ['ssh:devbox', 'ssh:devbox'],
    ['ssh:team box', 'ssh:team%20box'],
    ['ssh:team%20box', 'ssh:team%20box']
  ])('passes %s through as %s', (value, expected) => {
    expect(readWorkspaceRouteExecutionHost(value)).toBe(expected)
  })

  it.each([undefined, '', '   ', 'bogus', 'runtime:', 'ssh:', 'runtime:a|b'])(
    'returns undefined for %j',
    (value) => {
      expect(readWorkspaceRouteExecutionHost(value)).toBeUndefined()
    }
  )

  it('uses the first element of a repeated param', () => {
    expect(readWorkspaceRouteExecutionHost(['runtime:wsl:ubuntu-22.04', 'local'])).toBe(
      'runtime:wsl%3Aubuntu-22.04'
    )
  })
})
