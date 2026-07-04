import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'

const {
  getPwshAvailabilityDiagnostic,
  isPwshAvailable,
  isWslAvailable,
  listWslDistros,
  isGitBashAvailable
} = vi.hoisted(() => ({
  getPwshAvailabilityDiagnostic: vi.fn(),
  isPwshAvailable: vi.fn(),
  isWslAvailable: vi.fn(),
  listWslDistros: vi.fn(),
  isGitBashAvailable: vi.fn()
}))

vi.mock('../../../pwsh', () => ({ getPwshAvailabilityDiagnostic, isPwshAvailable }))
vi.mock('../../../wsl', () => ({ isWslAvailable, listWslDistros }))
vi.mock('../../../git-bash', () => ({ isGitBashAvailable }))

import { HOST_CAPABILITY_METHODS } from './host-capabilities'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('host capability RPC methods', () => {
  beforeEach(() => {
    isPwshAvailable.mockReset()
    getPwshAvailabilityDiagnostic.mockReset()
    isWslAvailable.mockReset()
    listWslDistros.mockReset()
    isGitBashAvailable.mockReset()
  })

  it('reports Windows shell capability probes through explicit methods', async () => {
    isPwshAvailable.mockReturnValue(true)
    getPwshAvailabilityDiagnostic.mockReturnValue({
      family: 'pwsh.exe',
      resolvedPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      candidateCount: 1,
      rejectedAliasCandidates: [],
      searchedPath: true,
      reason: 'resolved'
    })
    isWslAvailable.mockReturnValue(true)
    listWslDistros.mockReturnValue(['Ubuntu'])
    isGitBashAvailable.mockReturnValue(true)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: HOST_CAPABILITY_METHODS })

    await expect(dispatcher.dispatch(makeRequest('host.pwsh.isAvailable'))).resolves.toMatchObject({
      ok: true,
      result: true
    })
    await expect(
      dispatcher.dispatch(makeRequest('host.pwsh.getDiagnostic'))
    ).resolves.toMatchObject({
      ok: true,
      result: {
        reason: 'resolved',
        resolvedPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
      }
    })
    await expect(dispatcher.dispatch(makeRequest('host.wsl.isAvailable'))).resolves.toMatchObject({
      ok: true,
      result: true
    })
    await expect(dispatcher.dispatch(makeRequest('host.wsl.listDistros'))).resolves.toMatchObject({
      ok: true,
      result: ['Ubuntu']
    })
    await expect(
      dispatcher.dispatch(makeRequest('host.gitBash.isAvailable'))
    ).resolves.toMatchObject({
      ok: true,
      result: true
    })
  })
})
