import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getPreflightWslTarget } from '../ipc/preflight-runtime-target'
import type { GlobalWindowsRuntimeDefault } from '../../shared/project-execution-runtime'

vi.mock('../wsl', () => ({
  hasCachedWslAvailability: () => false,
  getCachedWslAvailability: () => null,
  hasCachedWslDistros: () => false,
  getCachedWslDistros: () => null
}))

const originalPlatform = process.platform

function makeRuntime(localWindowsRuntimeDefault?: GlobalWindowsRuntimeDefault) {
  const store = { getSettings: () => ({ localWindowsRuntimeDefault }) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: getHostAgentPreflightContext reads only store.getSettings.
  return new OrcaRuntimeService(store as never)
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

describe('OrcaRuntimeService.getHostAgentPreflightContext', () => {
  afterEach(() => {
    setPlatform(originalPlatform)
  })

  it('targets the named WSL distro of the host default', () => {
    setPlatform('win32')
    const context = makeRuntime({ kind: 'wsl', distro: 'Ubuntu' }).getHostAgentPreflightContext()
    expect(context).toMatchObject({
      projectRuntime: { runtime: { kind: 'wsl', distro: 'Ubuntu' } }
    })
    expect(getPreflightWslTarget(context, 'win32')).toEqual({ distro: 'Ubuntu' })
  })

  it('surfaces the launch repair error for a WSL default without a distro', () => {
    setPlatform('win32')
    const context = makeRuntime({ kind: 'wsl', distro: null }).getHostAgentPreflightContext()
    expect(() => getPreflightWslTarget(context, 'win32')).toThrow('wsl-distro-required')
  })

  it('keeps the native PATH for a Windows-host default or a non-Windows host', () => {
    setPlatform('win32')
    const windowsHost = makeRuntime({ kind: 'windows-host' }).getHostAgentPreflightContext()
    expect(getPreflightWslTarget(windowsHost, 'win32')).toBeNull()
    setPlatform('linux')
    const linux = makeRuntime({ kind: 'wsl', distro: 'Ubuntu' }).getHostAgentPreflightContext()
    expect(getPreflightWslTarget(linux, 'linux')).toBeNull()
  })

  it('returns no context without a store', () => {
    expect(new OrcaRuntimeService().getHostAgentPreflightContext()).toBeUndefined()
  })
})
