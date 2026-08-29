import { describe, expect, it } from 'vitest'
import { DESKTOP_HOST_DEV_PORT } from '../shared/desktop-host-protocol'
import { resolveDesktopHostListenConfig } from './desktop-host-config'

describe('resolveDesktopHostListenConfig', () => {
  it('defaults the Tauri sidecar to the reserved dev port', () => {
    const config = resolveDesktopHostListenConfig({})
    expect(config.port).toBe(DESKTOP_HOST_DEV_PORT)
    expect(config.host).toBe('127.0.0.1')
  })

  it('refuses the packaged production websocket port', () => {
    expect(() => resolveDesktopHostListenConfig({ ORCA_DESKTOP_HOST_PORT: '6768' })).toThrow(/6768/)
  })

  it('honors an explicit non-production port', () => {
    const config = resolveDesktopHostListenConfig({
      ORCA_DESKTOP_HOST_PORT: '6771',
      ORCA_DESKTOP_USER_DATA_DIR: '/tmp/orca-tauri-host'
    })
    expect(config.port).toBe(6771)
    expect(config.userDataPath).toBe('/tmp/orca-tauri-host')
  })
})
