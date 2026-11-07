import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../core'

const { installForRuntimeHomeSerializedMock, realpathMock } = vi.hoisted(() => ({
  installForRuntimeHomeSerializedMock: vi.fn(),
  realpathMock: vi.fn()
}))

vi.mock('../../../../codex/hooks/installation/hook-service', () => ({
  codexHookService: { installForRuntimeHomeSerialized: installForRuntimeHomeSerializedMock }
}))
vi.mock('node:fs/promises', () => ({ realpath: realpathMock }))

import { AGENT_HOOK_METHODS } from './agent-hooks'
import {
  _internals as managedWslHomeRegistryInternals,
  recordManagedWslCodexHome
} from '../../../../codex/configuration/homes/managed-wsl-codex-home-registry'
const RUNTIME_HOME =
  '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\.local\\share\\orca\\codex-runtime-home\\home'

function prepareMethod() {
  const method = eraseRpcMethods(AGENT_HOOK_METHODS).find(
    (candidate) => candidate.name === 'agentHooks.prepareCodexForWslPane'
  )
  if (!method || isStreamingMethod(method)) {
    throw new Error('Missing agentHooks.prepareCodexForWslPane request method')
  }
  return method
}

function runtimeWithSettings(enabled = true, disabledTuiAgents: string[] = []): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook handler reads only requireStore/getSettings from this runtime fixture.
  return {
    requireStore: () => ({
      getSettings: () => ({
        agentStatusHooksEnabled: enabled,
        disabledTuiAgents
      })
    })
  } as unknown as OrcaRuntimeService
}

describe('agent hook RPC methods', () => {
  beforeEach(() => {
    installForRuntimeHomeSerializedMock.mockReset()
    realpathMock.mockReset()
    realpathMock.mockImplementation(async (path: string) => path)
    managedWslHomeRegistryInternals.clearRecordedManagedWslCodexHomes()
    recordManagedWslCodexHome('Ubuntu-24.04', RUNTIME_HOME)
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
})
