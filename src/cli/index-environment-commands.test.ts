import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  removeEnvironmentMock,
  resolveEnvironmentMock,
  listEphemeralVmRuntimesMock,
  updateEphemeralVmRuntimeStatusMock,
  provisionEphemeralVmRuntimeMock,
  cleanupEphemeralVmRuntimeMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  removeEnvironmentMock: vi.fn(),
  resolveEnvironmentMock: vi.fn(),
  listEphemeralVmRuntimesMock: vi.fn((): unknown[] => []),
  updateEphemeralVmRuntimeStatusMock: vi.fn(),
  provisionEphemeralVmRuntimeMock: vi.fn(),
  cleanupEphemeralVmRuntimeMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: removeEnvironmentMock,
  resolveEnvironment: resolveEnvironmentMock
}))

vi.mock('../shared/ephemeral-vm-runtime-store', () => ({
  listEphemeralVmRuntimes: listEphemeralVmRuntimesMock,
  updateEphemeralVmRuntimeStatus: updateEphemeralVmRuntimeStatusMock
}))

vi.mock('../main/ephemeral-vm-runtime-service', () => ({
  provisionEphemeralVmRuntime: provisionEphemeralVmRuntimeMock,
  cleanupEphemeralVmRuntime: cleanupEphemeralVmRuntimeMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca cli worktree awareness', () => {
  const temporaryDirectories: string[] = []

  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
    listEphemeralVmRuntimesMock.mockReset()
    listEphemeralVmRuntimesMock.mockReturnValue([])
    updateEphemeralVmRuntimeStatusMock.mockReset()
    provisionEphemeralVmRuntimeMock.mockReset()
    cleanupEphemeralVmRuntimeMock.mockReset()
    removeEnvironmentMock.mockReset()
    resolveEnvironmentMock.mockReset()
  })

  it('lists saved environments even when ORCA_ENVIRONMENT is set', async () => {
    process.env.ORCA_ENVIRONMENT = 'stale-env'
    listEnvironmentsMock.mockReturnValue([addEnvironmentFromPairingCodeMock()])
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['environment', 'list', '--json'], '/tmp/repo')

    expect(listEnvironmentsMock).toHaveBeenCalledWith('/tmp/orca-user-data')
    expect(callMock).not.toHaveBeenCalled()
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('token')
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('publicKeyB64')
  })

  it('adds saved environments even when ORCA_ENVIRONMENT is set', async () => {
    process.env.ORCA_ENVIRONMENT = 'stale-env'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['environment', 'add', '--name', 'desk', '--pairing-code', 'orca://pair#abc', '--json'],
      '/tmp/repo'
    )

    expect(addEnvironmentFromPairingCodeMock).toHaveBeenCalledWith('/tmp/orca-user-data', {
      name: 'desk',
      pairingCode: 'orca://pair#abc'
    })
    expect(callMock).not.toHaveBeenCalled()
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('token')
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('publicKeyB64')
  })

  it('creates a recipe-backed environment and records its ownership without exposing secrets', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-environment-create-'))
    temporaryDirectories.push(repoPath)
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      ['environmentRecipes:', '  - id: cloud', '    name: Cloud', '    create: ./create.sh'].join(
        '\n'
      )
    )
    callMock.mockResolvedValue({
      ok: true,
      result: {
        repos: [
          {
            id: 'repo-1',
            path: repoPath,
            displayName: 'repo',
            badgeColor: '#000',
            addedAt: 1
          }
        ]
      },
      _meta: { runtimeId: 'local' }
    })
    const runtime = {
      id: 'orca-runtime-12345678',
      recipeId: 'cloud',
      status: 'running',
      cleanupStatus: 'not_started',
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 1,
        pairingCode: 'orca://pair?code=secret',
        projectRoot: '/repo'
      }
    }
    provisionEphemeralVmRuntimeMock.mockResolvedValue({
      ok: true,
      start: { ok: true, result: runtime.recipeResult, stdout: '', stderr: '' },
      runtime
    })
    updateEphemeralVmRuntimeStatusMock.mockReturnValue({
      ...runtime,
      runtimeEnvironmentId: 'env-1'
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['environment', 'create', '--recipe', 'cloud', '--name', 'cloud-live', '--json'],
      repoPath
    )

    expect(addEnvironmentFromPairingCodeMock).toHaveBeenCalledWith('/tmp/orca-user-data', {
      name: 'cloud-live',
      pairingCode: 'orca://pair?code=secret',
      source: 'ephemeral-vm'
    })
    expect(updateEphemeralVmRuntimeStatusMock).toHaveBeenCalledWith(
      '/tmp/orca-user-data',
      runtime.id,
      { runtimeEnvironmentId: 'env-1' }
    )
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('secret')
  })

  it('returns actionable redacted recipe output when create fails', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-environment-create-failure-'))
    temporaryDirectories.push(repoPath)
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      ['environmentRecipes:', '  - id: cloud', '    name: Cloud', '    create: ./create.sh'].join(
        '\n'
      )
    )
    callMock.mockResolvedValue({
      ok: true,
      result: {
        repos: [
          {
            id: 'repo-1',
            path: repoPath,
            displayName: 'repo',
            badgeColor: '#000',
            addedAt: 1
          }
        ]
      },
      _meta: { runtimeId: 'local' }
    })
    provisionEphemeralVmRuntimeMock.mockResolvedValue({
      ok: false,
      start: {
        error: 'Recipe exited with code 1.',
        stdout: '',
        stderr: 'SSM tunnel failed; {"token":"secret-token"}'
      }
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['environment', 'create', '--recipe', 'cloud', '--json'], repoPath)

    const printed = String(logSpy.mock.calls[0]?.[0])
    expect(printed).toContain('SSM tunnel failed')
    expect(printed).not.toContain('secret-token')
    process.exitCode = 0
  })

  it('retains the pairing and reports the runtime when create rollback cleanup is skipped', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-environment-create-rollback-'))
    temporaryDirectories.push(repoPath)
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      ['environmentRecipes:', '  - id: cloud', '    name: Cloud', '    create: ./create.sh'].join(
        '\n'
      )
    )
    callMock.mockResolvedValue({
      ok: true,
      result: {
        repos: [
          {
            id: 'repo-1',
            path: repoPath,
            displayName: 'repo',
            badgeColor: '#000',
            addedAt: 1
          }
        ]
      },
      _meta: { runtimeId: 'local' }
    })
    const environment = {
      id: 'env-1',
      name: 'cloud-live',
      source: 'ephemeral-vm',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [],
      preferredEndpointId: 'ws-env-1'
    }
    const runtime = {
      id: 'runtime-needs-manual-cleanup',
      recipeId: 'cloud',
      status: 'running',
      cleanupStatus: 'disabled',
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 1,
        pairingCode: 'orca://pair?code=secret',
        projectRoot: '/repo'
      }
    }
    provisionEphemeralVmRuntimeMock.mockResolvedValue({
      ok: true,
      start: { ok: true, result: runtime.recipeResult, stdout: '', stderr: '' },
      runtime
    })
    addEnvironmentFromPairingCodeMock.mockReturnValue(environment)
    updateEphemeralVmRuntimeStatusMock.mockImplementationOnce(() => {
      throw new Error('could not link runtime ownership')
    })
    cleanupEphemeralVmRuntimeMock.mockResolvedValue({
      ok: true,
      runtime,
      skipped: true
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['environment', 'create', '--recipe', 'cloud', '--name', environment.name, '--json'],
      repoPath
    )

    expect(removeEnvironmentMock).not.toHaveBeenCalled()
    const printed = String(logSpy.mock.calls[0]?.[0])
    expect(printed).toContain('runtime-needs-manual-cleanup')
    expect(printed).toContain('may still be running')
    expect(printed).toContain('pairing was retained')
    expect(printed).not.toContain('secret')
    process.exitCode = 0
  })

  it('reports skipped provider cleanup when rejecting an SSH recipe result', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-environment-create-ssh-'))
    temporaryDirectories.push(repoPath)
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      ['environmentRecipes:', '  - id: cloud', '    name: Cloud', '    create: ./create.sh'].join(
        '\n'
      )
    )
    callMock.mockResolvedValue({
      ok: true,
      result: {
        repos: [
          {
            id: 'repo-1',
            path: repoPath,
            displayName: 'repo',
            badgeColor: '#000',
            addedAt: 1
          }
        ]
      },
      _meta: { runtimeId: 'local' }
    })
    const runtime = {
      id: 'runtime-ssh-needs-cleanup',
      recipeId: 'cloud',
      status: 'running',
      cleanupStatus: 'disabled',
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 1,
        connection: {
          type: 'ssh',
          target: { label: 'cloud', host: 'example.test', port: 22, username: 'dev' },
          projectRoot: '/repo'
        }
      }
    }
    provisionEphemeralVmRuntimeMock.mockResolvedValue({
      ok: true,
      start: { ok: true, result: runtime.recipeResult, stdout: '', stderr: '' },
      runtime
    })
    cleanupEphemeralVmRuntimeMock.mockResolvedValue({
      ok: true,
      runtime,
      skipped: true
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['environment', 'create', '--recipe', 'cloud', '--json'], repoPath)

    const printed = String(logSpy.mock.calls[0]?.[0])
    expect(printed).toContain('SSH recipes are not supported')
    expect(printed).toContain('runtime-ssh-needs-cleanup')
    expect(printed).toContain('may still be running')
    process.exitCode = 0
  })

  it('retains the pairing on destroy failure and removes it only after a successful retry', async () => {
    const environment = {
      id: 'env-1',
      name: 'cloud-live',
      source: 'ephemeral-vm',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [],
      preferredEndpointId: 'ws-env-1'
    }
    const runtime = {
      id: 'runtime-1',
      recipeId: 'cloud',
      recipe: { id: 'cloud', name: 'Cloud', create: './create.sh', destroy: './destroy.sh' },
      repoId: 'repo-1',
      runtimeEnvironmentId: environment.id,
      status: 'running',
      cleanupStatus: 'not_started',
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 1,
        pairingCode: 'orca://pair?code=secret',
        projectRoot: '/repo'
      }
    }
    resolveEnvironmentMock.mockReturnValue(environment)
    listEphemeralVmRuntimesMock.mockReturnValue([runtime])
    callMock.mockResolvedValue({
      ok: true,
      result: {
        repos: [
          {
            id: 'repo-1',
            path: '/repo',
            displayName: 'repo',
            badgeColor: '#000',
            addedAt: 1
          }
        ]
      },
      _meta: { runtimeId: 'local' }
    })
    cleanupEphemeralVmRuntimeMock.mockResolvedValue({
      ok: false,
      runtime,
      error: 'instance still running'
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['environment', 'destroy', '--environment', environment.name, '--json'], '/repo')

    expect(removeEnvironmentMock).not.toHaveBeenCalled()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('pairing was retained') }
    })
    process.exitCode = 0

    cleanupEphemeralVmRuntimeMock.mockResolvedValue({
      ok: true,
      runtime: { ...runtime, status: 'cleaned', cleanupStatus: 'succeeded' },
      skipped: false
    })
    removeEnvironmentMock.mockReturnValue(environment)
    await main(['environment', 'destroy', '--environment', environment.name, '--json'], '/repo')

    expect(removeEnvironmentMock).toHaveBeenCalledWith('/tmp/orca-user-data', environment.id)
    const cleanupOrder = cleanupEphemeralVmRuntimeMock.mock.invocationCallOrder[1]
    const removeOrder = removeEnvironmentMock.mock.invocationCallOrder[0]
    expect(cleanupOrder).toBeDefined()
    expect(removeOrder).toBeDefined()
    if (cleanupOrder === undefined || removeOrder === undefined) {
      throw new Error('Expected cleanup and pairing removal calls.')
    }
    expect(cleanupOrder).toBeLessThan(removeOrder)
    expect(JSON.parse(String(logSpy.mock.calls[1]?.[0]))).toMatchObject({ ok: true })
  })

  it('refuses to forget a recipe-managed environment without an explicit force override', async () => {
    const environment = {
      id: 'env-1',
      name: 'cloud-live',
      source: 'ephemeral-vm',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [],
      preferredEndpointId: 'ws-env-1'
    }
    resolveEnvironmentMock.mockReturnValue(environment)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['environment', 'rm', '--environment', environment.name, '--json'], '/repo')

    expect(removeEnvironmentMock).not.toHaveBeenCalled()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('lifecycle record is missing') }
    })
    process.exitCode = 0
  })

  it('reports forced removal of a recipe-managed environment as skipped cleanup', async () => {
    const environment = {
      id: 'env-1',
      name: 'cloud-live',
      source: 'ephemeral-vm',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [],
      preferredEndpointId: 'ws-env-1'
    }
    const runtime = {
      id: 'runtime-1',
      recipeId: 'cloud',
      repoId: 'repo-1',
      runtimeEnvironmentId: environment.id,
      status: 'running',
      cleanupStatus: 'not_started',
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 1,
        pairingCode: 'orca://pair?code=secret',
        projectRoot: '/repo'
      }
    }
    resolveEnvironmentMock.mockReturnValue(environment)
    listEphemeralVmRuntimesMock.mockReturnValue([runtime])
    removeEnvironmentMock.mockReturnValue(environment)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['environment', 'rm', '--environment', environment.name, '--force', '--json'],
      '/repo'
    )

    expect(cleanupEphemeralVmRuntimeMock).not.toHaveBeenCalled()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      result: {
        providerCleanup: 'forced-skipped',
        providerState: { runtimeId: runtime.id, status: 'running' }
      }
    })
  })
})
