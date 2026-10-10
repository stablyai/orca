import { afterEach, describe, expect, it, vi } from 'vitest'
import { shellSwitchDecision } from './shell-switch-decision'

const ROUTE = { pathname: '/h/host-1/files/wt-1' }

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the hybrid shell switch decision', () => {
  it('answers the shell, carrying the route, in an OTA build', () => {
    vi.stubEnv('EXPO_PUBLIC_MOBILE_SHELL', 'ota')
    expect(shellSwitchDecision(ROUTE)).toEqual({ kind: 'shell', route: ROUTE })
  })

  it.each([[undefined], ['native'], ['']])(
    'answers native in a build whose switch is %p',
    (value) => {
      vi.stubEnv('EXPO_PUBLIC_MOBILE_SHELL', value)
      expect(shellSwitchDecision(ROUTE)).toEqual({ kind: 'native' })
    }
  )

  it('answers native for a route the shell could never open, even in an OTA build', () => {
    vi.stubEnv('EXPO_PUBLIC_MOBILE_SHELL', 'ota')
    expect(shellSwitchDecision(null)).toEqual({ kind: 'native' })
  })
})
