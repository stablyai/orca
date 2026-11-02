import { describe, expect, it } from 'vitest'
import { requireLocalSshBrowserRouteTarget } from './local-ssh-browser-route'

const targets = [{ id: 'target-a', generation: 4 }]

describe('local SSH browser target registration', () => {
  it('accepts the current managed deployment registration', () => {
    expect(() => requireLocalSshBrowserRouteTarget(targets, 'target-a', 4)).not.toThrow()
  })

  it('preserves direct SSH callers that do not supply a deployment fence', () => {
    expect(() => requireLocalSshBrowserRouteTarget(targets, 'target-a')).not.toThrow()
  })

  it.each([3, 5, '4', null])(
    'refuses a stale or invalid deployment registration: %j',
    (generation) => {
      expect(() => requireLocalSshBrowserRouteTarget(targets, 'target-a', generation)).toThrow(
        'browser_local_route_target_stale'
      )
    }
  )

  it('refuses a removed target instead of borrowing another route', () => {
    expect(() => requireLocalSshBrowserRouteTarget(targets, 'target-b', 4)).toThrow(
      'browser_local_route_target_invalid'
    )
  })
})
