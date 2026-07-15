import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { isStreamingMethod, type RpcContext } from '../core'

const {
  installForRuntimeHomeSerializedMock,
  realpathMock,
  getManagedAgentHookStatusesMock,
  getActiveSshAgentHookInstallReportsMock
} = vi.hoisted(() => ({
  installForRuntimeHomeSerializedMock: vi.fn(),
  realpathMock: vi.fn(),
  getManagedAgentHookStatusesMock: vi.fn(),
  getActiveSshAgentHookInstallReportsMock: vi.fn()
}))

vi.mock('../../../codex/hook-service', () => ({
  codexHookService: { installForRuntimeHomeSerialized: installForRuntimeHomeSerializedMock }
}))
vi.mock('node:fs/promises', () => ({ realpath: realpathMock }))
vi.mock('../../../agent-hooks/managed-agent-hook-controls', () => ({
  getManagedAgentHookStatuses: getManagedAgentHookStatusesMock
}))
vi.mock('../../../ipc/ssh', () => ({
  getActiveSshAgentHookInstallReports: getActiveSshAgentHookInstallReportsMock
}))

import { AGENT_HOOK_METHODS } from './agent-hooks'
import {
  _internals as managedWslHomeRegistryInternals,
  recordManagedWslCodexHome
} from '../../../codex/managed-wsl-codex-home-registry'

const LINUX_HOME = '/home/jin/.local/share/orca/codex-runtime-home/home'
const RUNTIME_HOME =
  '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\.local\\share\\orca\\codex-runtime-home\\home'

function prepareMethod() {
  const method = AGENT_HOOK_METHODS.find(
    (candidate) => candidate.name === 'agentHooks.prepareCodexForWslPane'
  )
  if (!method || isStreamingMethod(method)) {
    throw new Error('Missing agentHooks.prepareCodexForWslPane request method')
  }
  return method
}

function statusMethod() {
  const method = AGENT_HOOK_METHODS.find((candidate) => candidate.name === 'agentHooks.status')
  if (!method || isStreamingMethod(method)) {
    throw new Error('Missing agentHooks.status request method')
  }
  return method
}

function runtimeWithSettings(enabled = true, disabledTuiAgents: string[] = []): OrcaRuntimeService {
  return {
    getClientSettings: vi.fn(() => ({
      agentStatusHooksEnabled: enabled,
      disabledTuiAgents
    }))
  } as unknown as OrcaRuntimeService
}

describe('agent hook RPC methods', () => {
  beforeEach(() => {
    installForRuntimeHomeSerializedMock.mockReset()
    realpathMock.mockReset()
    realpathMock.mockImplementation(async (path: string) => path)
    managedWslHomeRegistryInternals.clearRecordedManagedWslCodexHomes()
    recordManagedWslCodexHome('Ubuntu-24.04', RUNTIME_HOME)
    getManagedAgentHookStatusesMock.mockReset()
    getActiveSshAgentHookInstallReportsMock.mockReset()
  })

  it('returns local and active SSH hook install reports', async () => {
    const local = [{ agent: 'codex', state: 'installed' }]
    const remotes = [{ targetId: 'ssh-1', state: 'partial' }]
    getManagedAgentHookStatusesMock.mockReturnValue(local)
    getActiveSshAgentHookInstallReportsMock.mockReturnValue(remotes)

    await expect(statusMethod().handler(undefined, { runtime: runtimeWithSettings() })).resolves.toEqual(
      { local, remotes }
    )
  })

  it('installs the pane-selected WSL home once and returns its status', async () => {
    const status = { agent: 'codex', state: 'installed' }
    installForRuntimeHomeSerializedMock.mockResolvedValue(status)
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: LINUX_HOME,
      orcaCodexHome: LINUX_HOME,
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(method.handler(params, { runtime: runtimeWithSettings() })).resolves.toBe(status)
    expect(installForRuntimeHomeSerializedMock).toHaveBeenCalledExactlyOnceWith(RUNTIME_HOME, {
      runtime: 'wsl',
      wslDistro: 'Ubuntu-24.04'
    })
  })

  it.each([
    [false, []],
    [true, ['codex']]
  ])('does not install when hooks are disabled (%s, %j)', async (enabled, disabledTuiAgents) => {
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(
      method.handler(params, { runtime: runtimeWithSettings(enabled, disabledTuiAgents) })
    ).resolves.toBeNull()
    expect(installForRuntimeHomeSerializedMock).not.toHaveBeenCalled()
  })

  it.each(['runtime', 'mobile'] as const)('rejects non-local %s callers', async (clientKind) => {
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(
      method.handler(params, {
        runtime: runtimeWithSettings(),
        clientKind
      } as RpcContext)
    ).rejects.toThrow(/only available to the local Orca CLI/)
    expect(installForRuntimeHomeSerializedMock).not.toHaveBeenCalled()
  })

  it('propagates an attempted installer failure', async () => {
    installForRuntimeHomeSerializedMock.mockRejectedValue(new Error('install failed'))
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(method.handler(params, { runtime: runtimeWithSettings() })).rejects.toThrow(
      'install failed'
    )
    expect(installForRuntimeHomeSerializedMock).toHaveBeenCalledOnce()
  })

  it('rejects a managed-looking home that resolves through a symlink', async () => {
    realpathMock.mockResolvedValue(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\outside-managed-home'
    )
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: LINUX_HOME,
      orcaCodexHome: LINUX_HOME,
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(method.handler(params, { runtime: runtimeWithSettings() })).resolves.toBeNull()
    expect(installForRuntimeHomeSerializedMock).not.toHaveBeenCalled()
  })

  it('rejects malformed distro names at the RPC schema', () => {
    const method = prepareMethod()

    expect(() =>
      method.params!.parse({
        codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
        orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
        wslDistro: 'Ubuntu\\..\\host'
      })
    ).toThrow()
  })
})
