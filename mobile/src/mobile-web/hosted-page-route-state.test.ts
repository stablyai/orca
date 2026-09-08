import { describe, expect, it } from 'vitest'
import { hostedPageRouteState, hostedPageStateTarget } from './hosted-page-route-state'

describe('hosted page route state', () => {
  it.each([
    '/settings',
    '/native-chat-settings',
    '/browser-settings',
    '/troubleshoot',
    '/connection-log',
    '/notifications',
    '/voice-settings',
    '/terminal-settings',
    '/about'
  ])('roundtrips %s without document-scoped handles', (pathname) => {
    const state = hostedPageRouteState(pathname)
    expect(hostedPageStateTarget(state)).toBe(pathname)
    expect(JSON.parse(state!)).toEqual({ version: 1, pathname })
  })

  it.each([
    undefined,
    '',
    '{',
    'null',
    '[]',
    JSON.stringify({ version: 2, pathname: '/native-chat-settings' }),
    JSON.stringify({ version: 1, pathname: '//external.example' }),
    JSON.stringify({ version: 1, pathname: '/h/paired-orca-desktop/session/opaque' })
  ])('falls back safely for unknown state %s', (state) => {
    expect(hostedPageStateTarget(state)).toBeUndefined()
  })

  it('never stores a session or resource handle as a durable page route', () => {
    expect(hostedPageRouteState('/h/paired-orca-desktop/session/opaque')).toBeUndefined()
  })
})
