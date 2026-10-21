import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import {
  addManagedOrcadEnvironment,
  refreshManagedOrcadPairing
} from '../../../shared/runtime-environment-managed-orcad-store'
import { pairingCode } from './runtime-environments-ipc-test-harness'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../shared/protocol-version'
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
vi.mock('../../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequest: mocks.request
}))
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
// Why: the tunnel is standing; these cases are about what answers through it.
vi.mock('./runtime-environment-managed-tunnel', () => ({
  resolveManagedRuntimeEnvironment: vi.fn(async () => undefined)
}))

import { getRuntimeEnvironmentStatus } from './runtime-environment-status-probe'
import { resetRuntimeEnvironmentStatusOwners } from './runtime-environment-request-connections'
import { setRefusedPairingHandlers } from './runtime-environment-pairing-refusal-registry'

let directory: string
let envId: string
beforeEach(() => {
  vi.clearAllMocks()
  resetRuntimeEnvironmentCapabilityEvidence()
  directory = mkdtempSync(join(tmpdir(), 'orca-status-retirement-'))
  envId = addManagedOrcadEnvironment(directory, {
    id: 'env-managed',
    name: 'Host',
    now: 1,
    pairingCode: pairingCode(),
    orcadDeployment: {
      sshTargetId: 'box',
      sshTargetGeneration: 1,
      localPort: 6768,
      remotePort: 6768
    }
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

/** What a re-pair over SSH does mid-probe: store a new pairing and retire the old transports. */
function repairMidProbe(now: number, keyByte = 1): void {
  refreshManagedOrcadPairing(
    directory,
    envId,
    pairingCode(undefined, { deviceToken: `token-${now}`, keyByte }),
    now
  )
  advanceRuntimeEnvironmentCapabilityIncarnation(envId)
}

it('answers from the successor owner when the probe itself re-paired the server', async () => {
  mocks.request.mockImplementationOnce(async () => {
    repairMidProbe(2)
    return {
      id: 'status',
      ok: false,
      error: { code: 'unauthorized', message: 'refused' },
      _meta: { runtimeId: 'old-host' }
    }
  })
  mocks.request.mockResolvedValueOnce(response())
  await expect(
    getRuntimeEnvironmentStatus(directory, envId, undefined, { reconnect: true })
  ).resolves.toMatchObject({ ok: true })
  expect(mocks.request).toHaveBeenCalledTimes(2)
})

it.each([
  ['a pairing under another host key', () => repairMidProbe(2, 2), true],
  ['a caller pinned to the old pairing', () => repairMidProbe(2), false]
] as const)('never answers %s from the replacement', async (_name, replace, follow) => {
  mocks.request.mockImplementationOnce(async () => {
    replace()
    return response()
  })
  mocks.request.mockResolvedValue(response())
  await expect(
    getRuntimeEnvironmentStatus(directory, envId, undefined, undefined, follow)
  ).resolves.toMatchObject({ ok: false, error: { code: 'runtime_environment_changed' } })
  expect(mocks.request).toHaveBeenCalledOnce()
})

it('follows a re-pair only once', async () => {
  let now = 2
  mocks.request.mockImplementation(async () => {
    repairMidProbe(now++)
    return response()
  })
  await expect(getRuntimeEnvironmentStatus(directory, envId)).resolves.toMatchObject({
    ok: false,
    error: { code: 'runtime_environment_changed' }
  })
  expect(mocks.request).toHaveBeenCalledTimes(2)
})

it('does not claim the pairing changed when the refusal only rebuilt the tunnel', async () => {
  const noRecovery = { recover: () => null, sharedControl: () => null, connectRequested: () => {} }
  setRefusedPairingHandlers({ ...noRecovery, recover: async () => 'built' as const })
  mocks.request.mockResolvedValueOnce({
    id: 'status',
    ok: false,
    error: { code: 'unauthorized', message: 'refused' },
    _meta: { runtimeId: 'old-host' }
  })
  try {
    const answer = await getRuntimeEnvironmentStatus(directory, envId)
    expect(answer).toMatchObject({ ok: false, error: { code: 'runtime_environment_changed' } })
    expect(JSON.stringify(answer)).not.toMatch(/pairing changed/)
  } finally {
    setRefusedPairingHandlers(noRecovery)
  }
})
