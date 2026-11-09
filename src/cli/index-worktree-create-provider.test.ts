import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
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
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { buildWorktree, okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import { agentLaunchHostFixture } from './agent-launch-test-fixtures'
import { WORKSPACE_PROVIDERS_RUNTIME_CAPABILITY } from '../shared/recipe-workspace-create-progress'

// main() never clears exitCode, so a failing test would otherwise satisfy later exitCode checks.
const originalExitCode = process.exitCode
beforeEach(() => {
  process.exitCode = undefined
})
afterEach(() => {
  process.exitCode = originalExitCode
})

const create = ['worktree', 'create', '--repo', 'id:source', '--name', 'task', '--no-parent']
const capableHost = () =>
  okFixture('status', { capabilities: [WORKSPACE_PROVIDERS_RUNTIME_CAPABILITY] })
const createdOnProvider = () =>
  okFixture('create', {
    worktree: buildWorktree('/workspace/repo-task', 'task', 'head', 'remote'),
    host: {
      id: 'runtime:env-vm',
      origin: { target: 'recipe:dev-vm', runtimeId: 'vm-1' },
      lifecycle: 'per-workspace',
      state: 'running',
      checkoutMode: 'orca-worktree'
    }
  })
function stdout(log: ReturnType<typeof vi.spyOn>): string {
  return log.mock.calls.flat().join('\n')
}

describe('orca worktree create --on <provider>', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('creates on the provider with a typed target and an idempotency key, and prints a versioned result', async () => {
    queueFixtures(callMock, capableHost(), createdOnProvider())
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      [...create, '--on', 'recipe:dev-vm', '--idempotency-key', 'key-1', '--json'],
      '/outside'
    )
    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'worktree.create',
      expect.objectContaining({
        repo: 'id:source',
        target: { kind: 'recipe', id: 'dev-vm' },
        clientMutationId: 'key-1',
        activate: false
      }),
      expect.objectContaining({ onProgress: expect.any(Function) })
    )
    const printed = JSON.parse(stdout(log))
    expect(printed.result).toMatchObject({
      schemaVersion: 1,
      idempotencyKey: 'key-1',
      host: { id: 'runtime:env-vm', origin: { target: 'recipe:dev-vm', runtimeId: 'vm-1' } }
    })
    expect(process.exitCode).toBeUndefined()
  })

  it('generates an idempotency key when none is given, so a rerun can reuse it', async () => {
    queueFixtures(callMock, capableHost(), createdOnProvider())
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await main([...create, '--on', 'plugin:acme/gpu-box'], '/outside')
    expect(callMock.mock.calls[1]?.[1]).toMatchObject({
      target: { kind: 'plugin', pluginKey: 'acme', id: 'gpu-box' },
      clientMutationId: expect.any(String)
    })
  })

  it('writes progress as JSON lines on stderr and keeps stdout to the result', async () => {
    callMock.mockImplementationOnce(async () => capableHost())
    callMock.mockImplementationOnce(
      async (
        _method: string,
        _params: unknown,
        options?: { onProgress?: (p: unknown) => void }
      ) => {
        options?.onProgress?.({ phase: 'running-create' })
        options?.onProgress?.({ phase: 'host-recorded', runtimeId: 'vm-1' })
        options?.onProgress?.({ phase: 'not-a-phase' })
        return createdOnProvider()
      }
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await main([...create, '--on', 'recipe:dev-vm', '--progress', 'json', '--json'], '/outside')
    const events = stderr.mock.calls.map(([chunk]) => JSON.parse(String(chunk)))
    expect(events).toEqual([
      expect.objectContaining({
        event: 'started',
        target: 'recipe:dev-vm',
        idempotencyKey: expect.any(String)
      }),
      expect.objectContaining({ event: 'phase', phase: 'running-create' }),
      expect.objectContaining({ event: 'phase', phase: 'host-recorded', runtimeId: 'vm-1' })
    ])
    expect(JSON.parse(stdout(log)).ok).toBe(true)
    stderr.mockRestore()
  })

  it.each([
    ['--on', 'recipe:dev-vm', '--host', 'local'],
    ['--on', 'recipe:dev-vm', '--size', 'large'],
    ['--on', 'recipe:bad id'],
    ['--on', 'plugin:no-recipe'],
    ['--size', 'large'],
    // --repo already names the host; an existing-host --on with it would be silently different.
    ['--on', 'local'],
    // Provider-only flags never ride along silently with an existing host.
    ['--on', 'ssh:box', '--project', 'p', '--idempotency-key', 'k']
  ])('refuses %j with exit 2 before contacting the host', async (...extra) => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await main([...create, ...extra, '--json'], '/outside')
    expect(process.exitCode).toBe(2)
    expect(callMock.mock.calls.some(([method]) => method === 'worktree.create')).toBe(false)
  })

  it('exits 5 when the failed create may have left a machine running', async () => {
    callMock.mockImplementationOnce(async () => capableHost())
    callMock.mockImplementationOnce(async () => {
      const { RuntimeClientError } = await import('./runtime-client.js')
      throw new RuntimeClientError('host_create_failed', 'Boom.', {
        phase: 'checking-host',
        target: 'recipe:dev-vm',
        host: { runtimeId: 'vm-1', state: 'destroy-failed' }
      })
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await main([...create, '--on', 'recipe:dev-vm', '--idempotency-key', 'k', '--json'], '/outside')
    expect(process.exitCode).toBe(5)
    const printed = JSON.parse(stdout(log))
    expect(printed.error).toMatchObject({
      code: 'host_create_failed',
      data: { idempotencyKey: 'k', host: { runtimeId: 'vm-1', state: 'destroy-failed' } }
    })
  })

  it('exits 5 with the recorded environment when contact is lost after it was created', async () => {
    callMock.mockImplementationOnce(async () => capableHost())
    callMock.mockImplementationOnce(
      async (
        _method: string,
        _params: unknown,
        options?: { onProgress?: (p: unknown) => void }
      ) => {
        options?.onProgress?.({ phase: 'host-recorded', runtimeId: 'vm-9' })
        const { RuntimeClientError } = await import('./runtime-client.js')
        throw new RuntimeClientError('runtime_unavailable', 'Orca closed the connection.')
      }
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await main([...create, '--on', 'recipe:dev-vm', '--json'], '/outside')
    expect(process.exitCode).toBe(5)
    expect(JSON.parse(stdout(log)).error).toMatchObject({
      code: 'host_create_failed',
      data: { host: { runtimeId: 'vm-9', state: 'unknown' }, idempotencyKey: expect.any(String) }
    })
  })

  it('exits 1 when the failed create destroyed what it started', async () => {
    callMock.mockImplementationOnce(async () => capableHost())
    callMock.mockImplementationOnce(async () => {
      const { RuntimeClientError } = await import('./runtime-client.js')
      throw new RuntimeClientError('host_create_failed', 'Boom.', {
        phase: 'checking-host',
        target: 'recipe:dev-vm',
        host: { runtimeId: 'vm-1', state: 'destroyed' }
      })
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await main([...create, '--on', 'recipe:dev-vm', '--json'], '/outside')
    expect(process.exitCode).toBe(1)
  })

  it('exits 4 with the created workspace when the agent launch after it fails', async () => {
    queueFixtures(callMock, capableHost(), createdOnProvider(), agentLaunchHostFixture())
    callMock.mockRejectedValueOnce(new Error('socket closed'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await main(
      [...create, '--on', 'recipe:dev-vm', '--agent', 'codex', '--prompt', 'hi', '--json'],
      '/outside'
    )
    expect(process.exitCode).toBe(4)
    const printed = JSON.parse(stdout(log))
    expect(printed.error).toMatchObject({
      code: 'workspace_follow_up_failed',
      data: {
        result: { host: { origin: { runtimeId: 'vm-1' } } },
        followUp: { step: 'agent-launch' }
      }
    })
  })

  it('refuses a host without providers before any create', async () => {
    queueFixtures(callMock, okFixture('old', { capabilities: [] }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await main([...create, '--on', 'recipe:dev-vm', '--json'], '/outside')
    expect(process.exitCode).toBe(1)
    expect(callMock.mock.calls.some(([method]) => method === 'worktree.create')).toBe(false)
  })

  it('keeps exit 1 for ordinary worktree create refusals', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await main(
      ['worktree', 'create', '--repo', 'id:source', '--no-parent', '--setup', 'bogus', '--json'],
      '/outside'
    )
    expect(process.exitCode).toBe(1)
  })
})

describe('orca provider list / show', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })
  const listing = {
    schemaVersion: 1,
    providers: [
      {
        target: 'recipe:dev-vm',
        kind: 'recipe',
        name: 'Dev VM',
        repo: { id: 'source', name: 'orca', path: '/src/orca' },
        available: true,
        checkoutMode: 'orca-worktree',
        capabilities: { suspend: true, resume: true, destroy: true },
        timeoutSeconds: { create: 600 },
        sizes: [],
        inputs: []
      }
    ],
    diagnostics: [
      { repoId: 'source', index: 1, field: 'create', message: 'Missing create command.' }
    ]
  }

  it('lists providers with their --on targets', async () => {
    queueFixtures(callMock, capableHost(), okFixture('list', listing))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['provider', 'list', '--repo', 'id:source'], '/outside')
    expect(callMock).toHaveBeenNthCalledWith(2, 'provider.list', { repo: 'id:source' })
    expect(stdout(log)).toContain(
      'recipe:dev-vm  Dev VM  [orca-worktree; destroys on removal; timeouts create 600s]'
    )
    expect(stdout(log)).toContain(
      'warning: source environmentRecipes[1].create: Missing create command.'
    )
  })

  it('fails show for an unknown target with exit 2 and the valid targets', async () => {
    queueFixtures(callMock, capableHost(), okFixture('list', listing))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await main(['provider', 'show', 'recipe:other', '--json'], '/outside')
    expect(process.exitCode).toBe(2)
    expect(JSON.parse(stdout(log)).error).toMatchObject({
      code: 'invalid_argument',
      data: { target: 'recipe:other', valid: ['recipe:dev-vm'] }
    })
  })

  it('refuses a host target in show', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await main(['provider', 'show', 'local', '--json'], '/outside')
    expect(process.exitCode).toBe(2)
    expect(callMock).not.toHaveBeenCalled()
  })
})
