import { describe, expect, it } from 'vitest'
import { WS_BIND_HOST_LOOPBACK } from '../runtime/rpc/server/runtime-rpc-pairing-types'
import { normalizeServeModeArgv } from './serve-mode-argv'
import { getServeOptions } from './serve-options'
import { resolveServePinnedBindHost } from './serve-pinned-bind-host'

describe('Electron serve listener pin', () => {
  it('leaves the listener unpinned when --bind is absent, as before --bind existed', () => {
    const options = getServeOptions(['/AppRun', '--serve', '--serve-port', '6768'])
    expect(options).not.toHaveProperty('bind')
    expect(resolveServePinnedBindHost({ orcadSidecar: false, serveOptions: options })).toBe(
      undefined
    )
    expect(resolveServePinnedBindHost({ orcadSidecar: false, serveOptions: null })).toBe(undefined)
  })

  it('pins an explicit bind from either argv form, normalizing localhost', () => {
    const internal = getServeOptions(['/AppRun', '--serve', '--serve-bind', '100.64.1.20'])
    const cliForm = getServeOptions(
      normalizeServeModeArgv(['/AppRun', 'serve', '--bind', 'localhost'])
    )
    expect(resolveServePinnedBindHost({ orcadSidecar: false, serveOptions: internal })).toBe(
      '100.64.1.20'
    )
    expect(resolveServePinnedBindHost({ orcadSidecar: false, serveOptions: cliForm })).toBe(
      '127.0.0.1'
    )
  })

  it('keeps the orcad browser sidecar on loopback regardless of --bind', () => {
    expect(
      resolveServePinnedBindHost({ orcadSidecar: true, serveOptions: { bind: '0.0.0.0' } })
    ).toBe(WS_BIND_HOST_LOOPBACK)
  })

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
