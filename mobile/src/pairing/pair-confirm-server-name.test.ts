import { describe, expect, it } from 'vitest'
import { keepPairConfirmServerName, pairConfirmServerName } from './pair-confirm-server-name'

describe('pair-confirm server name', () => {
  it('names the server only for a page navigation, and strips the name from the route', () => {
    const code = 'orca://pair?code=abc_-1'
    // A deep link opens the route directly: its server param is never read.
    expect(pairConfirmServerName('orca://pair?code=deep-link')).toBeNull()

    const href = keepPairConfirmServerName(
      `/pair-confirm?code=${encodeURIComponent(code)}&server=${encodeURIComponent('Build server')}`
    )
    expect(href).toBe(`/pair-confirm?code=${encodeURIComponent(code)}`)
    expect(pairConfirmServerName(code)).toBe('Build server')
    expect(keepPairConfirmServerName('/h/host?server=x')).toBe('/h/host?server=x')
  })
})
