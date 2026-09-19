import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recoverOutgoingOrcadCapture } from './orcad-outgoing-capture-recovery'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'
import { createOrcadModelImportFixture } from '../orcad/orcad-model-import-test-fixture'
import {
  identity,
  preparation
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { runTargetLifecycle, targetLifecycleInFlight } from '../ipc/ssh-target-lifecycle-queue'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'

const mocks = vi.hoisted(() => ({
  environment: vi.fn(),
  target: vi.fn(),
  tunnel: vi.fn(),
  publish: vi.fn()
}))
vi.mock('../../shared/runtime-environment-store', () => ({ resolveEnvironment: mocks.environment }))
vi.mock('./orcad-managed-runtime-context', () => ({
  requireManagedOrcadTargetStore: () => ({ getTarget: mocks.target })
}))
vi.mock('./orcad-managed-tunnel', () => ({ ensureOrcadManagedTunnel: mocks.tunnel }))
vi.mock('./orcad-outgoing-capture-publication', () => ({
  publishOutgoingOrcadCapture: mocks.publish
}))
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-recover-'))
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
  mocks.tunnel.mockReset().mockResolvedValue(undefined)
  mocks.publish.mockReset().mockResolvedValue({ outcome: 'published' })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const source = createOrcadModelImportFixture(root)
  new OrcadOutgoingCaptureStore(root).persist({
    version: 1,
    identity,
    destinationEnvironmentId: 'destination',
    sourceSshTargetId: 'source',
    sourceSshTargetGeneration: 1,
    source: source.store.loadDelegatedSource(identity),
    model: source.model,
    selection: source.selection,
    surfaceBinding: preparation.surfacePublication.surfaceBinding
  })
  const target = { id: 'source', generation: 1, host: 'host', port: 22, username: 'user' }
  const environment = {
    id: 'destination',
    runtimeId: identity.destinationRuntimeId,
    createdAt: 1,
    pairingRevision: 1,
    endpoints: [
      { id: 'endpoint', endpoint: 'ws://host:1234', deviceToken: 'token', publicKeyB64: 'key' }
    ],
    preferredEndpointId: 'endpoint'
  }
  mocks.target.mockReturnValue(target)
  mocks.environment.mockReturnValue(environment)
  return { target, environment, args: { identity, signal: new AbortController().signal } }
}
it('resolves saved authority and holds both lifecycle queues during publication', async () => {
  const f = fixture()
  mocks.publish.mockImplementationOnce(async (options) => {
    expect(targetLifecycleInFlight.has('source')).toBe(true)
    expect(targetLifecycleInFlight.has(`runtime-ssh-access:${root}:destination`)).toBe(true)
    options.assertAuthority()
    return { outcome: 'published' }
  })
  await expect(recoverOutgoingOrcadCapture(root, f.args)).resolves.toEqual({ outcome: 'published' })
  expect(mocks.tunnel).toHaveBeenCalledWith(root, 'destination')
  expect(mocks.publish).toHaveBeenCalledWith(
    expect.objectContaining({
      identity,
      destinationEnvironmentId: 'destination',
      sourceSshTargetId: 'source',
      sourceSshTargetGeneration: 1
    })
  )
})
it('refuses without the explicit mutation canary', async () => {
  const f = fixture()
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '')
  await expect(recoverOutgoingOrcadCapture(root, f.args)).rejects.toThrow('mutation_disabled')
  expect(mocks.tunnel).not.toHaveBeenCalled()
  expect(mocks.publish).not.toHaveBeenCalled()
})
it.each(['target', 'pairing', 'runtime'])(
  'refuses %s changes during tunnel setup',
  async (change) => {
    const f = fixture()
    mocks.tunnel.mockImplementationOnce(async () => {
      if (change === 'target') {
        f.target.host = 'other'
      }
      if (change === 'pairing') {
        f.environment.pairingRevision++
      }
      if (change === 'runtime') {
        f.environment.runtimeId = 'other'
      }
    })
    await expect(recoverOutgoingOrcadCapture(root, f.args)).rejects.toThrow('authority_changed')
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(new OrcadOutgoingCaptureStore(root).read(identity)).not.toBeNull()
  }
)
it('revalidates source generation after waiting for a prior lifecycle operation', async () => {
  const f = fixture()
  let release!: () => void
  const blocker = runTargetLifecycle(
    'source',
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const recovery = recoverOutgoingOrcadCapture(root, f.args)
  const refused = expect(recovery).rejects.toThrow('target_changed')
  f.target.generation++
  release()
  await blocker
  await refused
  expect(mocks.publish).not.toHaveBeenCalled()
})
