import { describe, expect, it } from 'vitest'
import { DESKTOP_HOST_KIND } from '../shared/desktop-host-protocol'
import { DesktopHostPtyBroker } from './desktop-host-pty'
import { createDesktopHostStatus, invokeDesktopHostChannel } from './desktop-host-rpc'

describe('desktop host RPC', () => {
  it('reports a ready Tauri sidecar status without Electron', () => {
    const status = createDesktopHostStatus('runtime-1')
    expect(status.host).toBe(DESKTOP_HOST_KIND)
    expect(status.graphStatus).toBe('ready')
    expect(status.capabilities).toContain('desktop.pty.v1')
  })

  it('dispatches host.platform without importing electron', () => {
    const pty = new DesktopHostPtyBroker()
    const result = invokeDesktopHostChannel(
      { runtimeId: 'runtime-1', pty },
      'host.platform',
      undefined
    ) as { platform: NodeJS.Platform }
    expect(result.platform).toBe(process.platform)
  })

  it('rejects unknown invoke channels', () => {
    const pty = new DesktopHostPtyBroker()
    expect(() =>
      invokeDesktopHostChannel({ runtimeId: 'runtime-1', pty }, 'electron:ping', undefined)
    ).toThrow(/Unknown desktop host method/)
  })
})
