import { describe, expect, it } from 'vitest'
import { requireLocalSshBrowserRouteTarget } from './local-ssh-browser-route'

const target = { generation: 4 }

describe('local SSH browser target registration', () => {
  it('preserves direct SSH callers that do not supply a deployment fence', () => {
    expect(() => requireLocalSshBrowserRouteTarget(target)).not.toThrow()
  })

  it.each([3, 5, '4', null])(
    'refuses a stale or invalid deployment registration: %j',
    (generation) => {
      expect(() => requireLocalSshBrowserRouteTarget(target, generation)).toThrow(
        'browser_local_route_target_stale'
      )
    }
  )

  it('refuses a removed target instead of borrowing another route', () => {
    expect(() => requireLocalSshBrowserRouteTarget(undefined, 4)).toThrow(
      'browser_local_route_target_invalid'
    )
  })
})
