import { describe, expect, it } from 'vitest'
import {
  HOSTED_MOBILE_APP_ROUTE_URL,
  hostedMobileMetroArguments
} from '../../scripts/hosted-mobile-e2e-launch.mjs'

describe('hosted mobile E2E launch', () => {
  it('uses an Expo Router path URL', () => {
    expect(HOSTED_MOBILE_APP_ROUTE_URL).toBe('orca:///hybrid')
  })

  it('invalidates Metro transforms when the public host identity changes', () => {
    expect(hostedMobileMetroArguments(8081, true)).toEqual([
      'start',
      '--host',
      'lan',
      '--port',
      '8081',
      '--clear'
    ])
    expect(hostedMobileMetroArguments(8081, false)).not.toContain('--clear')
  })
})
