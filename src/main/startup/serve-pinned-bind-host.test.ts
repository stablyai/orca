import { describe, expect, it } from 'vitest'
import '../runtime/rpc/server/runtime-rpc-pairing-types'
import './serve-mode-argv'
import { getServeOptions } from './serve-options'
import './serve-pinned-bind-host'

describe('Electron serve listener pin', () => {
  it('rejects hostnames, empty values and --mobile-pairing with a narrower bind', () => {
    expect(() => getServeOptions(['/AppRun', '--serve', '--serve-bind'])).toThrow(
      'Missing value for --serve-bind.'
    )
    expect(() => getServeOptions(['/AppRun', '--serve', '--serve-bind', 'host.example'])).toThrow(
      /literal IP address/
    )
    expect(() =>
      getServeOptions(['/AppRun', '--serve', '--serve-bind', '127.0.0.1', '--serve-mobile-pairing'])
    ).toThrow(/--mobile-pairing needs --bind 0\.0\.0\.0/)
    expect(
      getServeOptions(['/AppRun', '--serve', '--serve-bind', '0.0.0.0', '--serve-mobile-pairing'])
        .mobilePairing
    ).toBe(true)
  })
})
