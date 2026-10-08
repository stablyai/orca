import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  addEnvironmentFromPairingCode,
  resolveEnvironment
} from '../../shared/runtime-environment-store'
import { pairingCode } from './runtime-environments-ipc-test-harness'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../shared/protocol-version'
import {
  advanceRuntimeEnvironmentCapabilityIncarnation,
  resetRuntimeEnvironmentCapabilityEvidence
} from './runtime-environment-capability-evidence'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  ensure: vi.fn(),
  reconnect: vi.fn(),
  diagnostics: vi.fn()
}))
vi.mock('../../shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest: mocks.request }))
vi.mock('./runtime-environment-request-connections', async () => {
  const { withRuntimeStatusOwners } = await import('./runtime-environments-ipc-test-harness')
  return withRuntimeStatusOwners({
    ensureRemoteRuntimeSharedControlConnection: mocks.ensure,
    reconnectRemoteRuntimeSharedControlConnection: mocks.reconnect,
    getRemoteRuntimeSharedControlDiagnostics: mocks.diagnostics,
    pauseRemoteRuntimeSharedControlRetry: vi.fn(),
    closeRemoteRuntimeRequestConnection: vi.fn()
  })
})
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import { getRuntimeEnvironmentStatus } from './runtime-environment-transport-routing'
import { resetRuntimeEnvironmentStatusOwners } from './runtime-environment-request-connections'

let directory: string
let envId: string
beforeEach(() => {
  vi.clearAllMocks()
  resetRuntimeEnvironmentCapabilityEvidence()
  directory = mkdtempSync(join(tmpdir(), 'orca-status-retirement-'))
  envId = addEnvironmentFromPairingCode(directory, {
    name: 'Host',
    now: 1,
    pairingCode: pairingCode(),
    connectionDependency: 'ssh-tunnel'
  }).id
  mocks.diagnostics.mockReturnValue(null)
})
afterEach(() => {
  resetRuntimeEnvironmentStatusOwners()
  rmSync(directory, { recursive: true, force: true })
})

function response() {
  return {
    id: 'status',
    ok: true as const,
    result: { runtimeId: 'old-host', capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY] },
    _meta: { runtimeId: 'old-host' }
  }
}

it.each(['success', 'failure', 'throw'] as const)(
  'fences a retired status probe settling with %s without publishing status or diagnostics',
  async (settlement) => {
    const pending = Promise.withResolvers<unknown>()
    mocks.request.mockReturnValue(pending.promise)
    const probe = getRuntimeEnvironmentStatus(directory, envId)
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledOnce())
    mocks.diagnostics.mockClear()
    advanceRuntimeEnvironmentCapabilityIncarnation(envId)
    if (settlement === 'throw') {
      pending.reject(new Error('old endpoint offline'))
    } else {
      pending.resolve(
        settlement === 'success'
          ? response()
          : {
              id: 'status',
              ok: false,
              error: { code: 'offline', message: 'old endpoint' },
              _meta: { runtimeId: 'old-host' }
            }
      )
    }
    await expect(probe).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_environment_changed' }
    })
    expect(resolveEnvironment(directory, envId).runtimeId).toBeNull()
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.reconnect).not.toHaveBeenCalled()
    expect(mocks.diagnostics).not.toHaveBeenCalled()
  }
)

it('does not fence another environment or a fresh probe after retirement', async () => {
  mocks.request.mockImplementation(async () => {
    advanceRuntimeEnvironmentCapabilityIncarnation('other')
    return response()
  })
  await expect(getRuntimeEnvironmentStatus(directory, envId)).resolves.toMatchObject({ ok: true })
  advanceRuntimeEnvironmentCapabilityIncarnation(envId)
  await expect(getRuntimeEnvironmentStatus(directory, envId)).resolves.toMatchObject({ ok: true })
  expect(resolveEnvironment(directory, envId).runtimeId).toBe('old-host')
  expect(mocks.ensure).toHaveBeenCalledTimes(2)
})
