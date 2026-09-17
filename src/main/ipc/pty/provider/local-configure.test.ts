import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { createPtyProviderTestDouble } from '../../../providers/pty-provider-test-double'
import { configureLocalPtyProvider } from './local-configure'
import { getInProcessPtyProvider, getLocalPtyProvider, setLocalPtyProvider } from './registry'

const originalInstalled = getLocalPtyProvider()

afterEach(() => {
  setLocalPtyProvider(originalInstalled)
  vi.restoreAllMocks()
})

describe('configureLocalPtyProvider', () => {
  it('configures the in-process provider once when it is also the installed one', () => {
    const inProcess = getInProcessPtyProvider()
    expect(getLocalPtyProvider()).toBe(inProcess)
    const configure = vi.spyOn(inProcess, 'configure')

    configureLocalPtyProvider({ trustedTerminalHandleEnv: new Set() })

    expect(configure).toHaveBeenCalledTimes(1)
  })

  it('still configures the in-process provider after a daemon topology is installed', () => {
    // Why: the daemon lands before handlers register, so this is the production order. Degraded
    // routing spawns fresh terminals on the in-process provider, which must carry hook env and
    // runtime callbacks even though it is no longer what IPC routes through.
    const daemonTopology = createPtyProviderTestDouble('daemon')
    setLocalPtyProvider(daemonTopology)
    const inProcess = getInProcessPtyProvider()
    const configure = vi.spyOn(inProcess, 'configure')

    configureLocalPtyProvider({ trustedTerminalHandleEnv: new Set() })

    expect(configure).toHaveBeenCalledTimes(1)
    expect(getLocalPtyProvider()).toBe(daemonTopology)
  })

  it('configures a separately installed LocalPtyProvider alongside the in-process one', () => {
    const installed = new LocalPtyProvider()
    setLocalPtyProvider(installed)
    const installedConfigure = vi.spyOn(installed, 'configure')
    const inProcessConfigure = vi.spyOn(getInProcessPtyProvider(), 'configure')

    configureLocalPtyProvider({ trustedTerminalHandleEnv: new Set() })

    expect(installedConfigure).toHaveBeenCalledTimes(1)
    expect(inProcessConfigure).toHaveBeenCalledTimes(1)
  })
})
