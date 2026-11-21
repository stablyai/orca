import '../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as OrcadManagedTunnelIdentity from './orcad-managed-tunnel-identity'
import type * as OrcadManagedBoundPort from './orcad-managed-bound-port'
import type * as OrcadManagedRuntimeContext from './orcad-managed-runtime-context'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { addManagedOrcadEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-managed-orcad-store'
import {
  markEnvironmentUsed,
  resolveEnvironment
} from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { ORCAD_IDENTITY_MISMATCH_CODE } from './orcad-managed-tunnel-identity'

const mocks = vi.hoisted(() => ({
  manager: {
    ensure: vi.fn(),
    close: vi.fn()
  },
  verifyIdentity: vi.fn(),
  readReadiness: vi.fn(),
  resolveContext: vi.fn()
}))

vi.mock('./orcad-managed-tunnel-manager', () => ({
  OrcadManagedTunnelManager: class {
    constructor() {
      Object.assign(this, mocks.manager)
    }
  }
}))
vi.mock('./orcad-managed-tunnel-pairing-recovery', () => ({
  buildWithPairingRepair: async (
    recovery: { resolve: (id: string) => Promise<unknown> },
    id: string,
    build: (environment: unknown) => Promise<void>
  ) => {
    await build(await recovery.resolve(id))
    return 'built'
  }
}))
vi.mock('./orcad-managed-tunnel-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof OrcadManagedTunnelIdentity>()),
  verifyManagedOrcadTunnelIdentity: mocks.verifyIdentity
}))
vi.mock('./orcad-managed-bound-port', async (importOriginal) => ({
  ...(await importOriginal<typeof OrcadManagedBoundPort>()),
  readActiveManagedOrcadReadiness: mocks.readReadiness
}))
vi.mock('./orcad-managed-runtime-context', async (importOriginal) => ({
  ...(await importOriginal<typeof OrcadManagedRuntimeContext>()),
  resolveLinkedOrcadContext: mocks.resolveContext
}))

import { ensureOrcadManagedTunnel } from './orcad-managed-tunnel'

describe('managed remote port recovery', () => {
  let userDataPath: string

  beforeEach(async () => {
    vi.resetAllMocks()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-managed-remote-port-'))
    await addManagedOrcadEnvironment(userDataPath, {
      id: 'environment-1',
      name: 'Managed server',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:46768',
        deviceToken: 'device-token',
        publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
        pairedDeviceId: 'device-1'
      }),
      orcadDeployment: {
        sshTargetId: 'ssh-1',
        sshTargetGeneration: 7,
        localPort: 46_768,
        remotePort: 6_768
      },
      now: 100
    })
    await markEnvironmentUsed(userDataPath, 'environment-1', { runtimeId: 'runtime-1' })
    mocks.manager.ensure.mockResolvedValue(7_001)
    mocks.verifyIdentity.mockResolvedValue({ verdict: 'verified', runtimeId: 'runtime-1' })
    mocks.readReadiness.mockResolvedValue({
      runtimeId: 'runtime-1',
      boundEndpoint: 'ws://127.0.0.1:7001'
    })
    mocks.resolveContext.mockResolvedValue({ target: {}, connection: {} })
  })

  afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

  it('saves the active port after the same runtime reconnects without closing its server', async () => {
    const before = await resolveEnvironment(userDataPath, 'environment-1')

    const current = await ensureOrcadManagedTunnel(userDataPath, 'environment-1')

    expect(current.orcadDeployment).toMatchObject({ remotePort: 7_001, localPort: 46_768 })
    expect(current.runtimeId).toBe('runtime-1')
    expect(current.pairingRevision).toBe(before.pairingRevision)
    expect(current.endpoints).toEqual(before.endpoints)
    expect(mocks.manager.close).not.toHaveBeenCalled()
  })

  it('does no identity or disk work when the active port is unchanged', async () => {
    mocks.manager.ensure.mockResolvedValue(6_768)
    const before = await resolveEnvironment(userDataPath, 'environment-1')

    const current = await ensureOrcadManagedTunnel(userDataPath, 'environment-1')

    expect(current).toEqual(before)
    expect(mocks.verifyIdentity).not.toHaveBeenCalled()
    expect(mocks.readReadiness).not.toHaveBeenCalled()
    expect(mocks.manager.close).not.toHaveBeenCalled()
  })

  it('rejects a different runtime without saving its port', async () => {
    mocks.verifyIdentity.mockResolvedValue({ verdict: 'verified', runtimeId: 'runtime-other' })

    await expect(ensureOrcadManagedTunnel(userDataPath, 'environment-1')).rejects.toMatchObject({
      code: ORCAD_IDENTITY_MISMATCH_CODE
    })

    expect((await resolveEnvironment(userDataPath, 'environment-1')).orcadDeployment).toMatchObject(
      { remotePort: 6_768 }
    )
    expect(mocks.manager.close).toHaveBeenCalledWith('environment-1')
  })

  it('rejects an unverifiable active endpoint without saving its port', async () => {
    mocks.readReadiness.mockResolvedValue(null)

    await expect(ensureOrcadManagedTunnel(userDataPath, 'environment-1')).rejects.toMatchObject({
      code: ORCAD_IDENTITY_MISMATCH_CODE
    })

    expect((await resolveEnvironment(userDataPath, 'environment-1')).orcadDeployment).toMatchObject(
      { remotePort: 6_768 }
    )
    expect(mocks.manager.close).toHaveBeenCalledWith('environment-1')
  })
})
