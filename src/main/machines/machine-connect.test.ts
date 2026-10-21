import { describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import type { MachineRecord } from '../../shared/machine-inventory'
import type { SshConnectionState, SshRemoteRuntimeResolution } from '../../shared/ssh-types'
import { SshConnectionStore } from '../ssh/connection/ssh-connection-store'
import { createMockStore } from '../ssh/connection/ssh-connection-store-test-fixture'
import {
  connectMachineOrcaServer,
  connectMachineSsh,
  machineSshTargetId,
  type MachinePairing,
  type MachineSshTargets
} from './machine-connect'
import { pairingCodeSha256 } from './machine-inventory-records'

vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => [],
  sshConfigHostsToTargets: () => []
}))

const FINGERPRINT = `SHA256:${'B'.repeat(43)}`
const RESOLUTION: SshRemoteRuntimeResolution = {
  rung: 'A',
  glibc: '2.39',
  runtimeSha256: 'abc',
  orcaMajor: 1
}

function record(overrides: Partial<MachineRecord> = {}): MachineRecord {
  return {
    id: 'sbx-1',
    name: 'omarchy-dev',
    lifetime: 'persistent',
    state: 'running',
    createdAt: '2026-10-18T00:00:00Z',
    providerKey: 'plugin:acme.omarchy/omarchy',
    lastSeenAt: 1,
    ...overrides
  }
}

function sshAccess(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'ssh' as const,
    host: 'omarchy',
    port: 42200,
    user: 'dev',
    projectRoot: '/home/dev/src',
    hostKeyFingerprints: [FINGERPRINT],
    ...overrides
  }
}

function harness(connectState: Partial<SshConnectionState> = { status: 'connected' }) {
  const mockStore = createMockStore()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every Store method SshConnectionStore calls.
  const store = new SshConnectionStore(mockStore as never)
  const calls: string[] = []
  const targets: MachineSshTargets = {
    getTarget: (id) => store.getTarget(id),
    ensureTarget: (id, fields) => {
      calls.push('ensure')
      return store.ensureMachineOwnedTarget(id, fields)
    },
    updateTarget: (id, updates) => {
      calls.push('update')
      return store.updateTarget(id, updates)
    },
    connect: async (id) => {
      calls.push('connect')
      return {
        targetId: id,
        error: null,
        reconnectAttempt: 0,
        status: 'connected',
        ...connectState
      }
    },
    disconnect: async () => {
      calls.push('disconnect')
    }
  }
  return { store, mockStore, targets, calls }
}

describe('connectMachineSsh', () => {
  it('creates a hidden machine-owned target that pins provider fingerprints', async () => {
    const { store, targets } = harness({
      status: 'connected',
      managedServer: { kind: 'managed', environmentId: 'env-1' }
    })
    const result = await connectMachineSsh(targets, record(), sshAccess())
    const id = machineSshTargetId('plugin:acme.omarchy/omarchy', 'sbx-1')
    expect(result).toEqual({ sshTargetId: id, environmentId: 'env-1' })
    expect(store.getTarget(id)).toMatchObject({
      host: 'omarchy',
      port: 42200,
      username: 'dev',
      owner: {
        type: 'machine',
        runtimeId: id,
        machineId: 'sbx-1',
        hostKeyFingerprints: [FINGERPRINT]
      }
    })
    expect(store.listTargets()).toEqual([])
  })

  it('keeps the target when the connect fails', async () => {
    const { store, targets } = harness({ status: 'error', error: 'Connection refused' })
    await expect(connectMachineSsh(targets, record(), sshAccess())).rejects.toThrow(
      'Connection refused'
    )
    expect(store.getTarget(machineSshTargetId(record().providerKey, 'sbx-1'))).toBeDefined()
  })

  it('disconnects before moving to a new endpoint and drops the stale runtime resolution', async () => {
    const { store, targets, calls } = harness()
    await connectMachineSsh(targets, record(), sshAccess())
    const id = machineSshTargetId(record().providerKey, 'sbx-1')
    store.updateTarget(id, { remoteRuntimeResolution: RESOLUTION })
    calls.length = 0

    await connectMachineSsh(targets, record(), sshAccess({ port: 42201 }))

    expect(calls).toEqual(['disconnect', 'update', 'connect'])
    expect(store.getTarget(id)).toMatchObject({ id, port: 42201 })
    expect(store.getTarget(id)?.remoteRuntimeResolution).toBeUndefined()
  })

  it('reconnects in place when only the pinned keys change', async () => {
    const { store, targets, calls } = harness()
    await connectMachineSsh(targets, record(), sshAccess())
    calls.length = 0
    const rotated = `SHA256:${'C'.repeat(43)}`
    await connectMachineSsh(targets, record(), sshAccess({ hostKeyFingerprints: [rotated] }))
    expect(calls).toEqual(['update', 'connect'])
    const owner = store.getTarget(machineSshTargetId(record().providerKey, 'sbx-1'))?.owner
    expect(owner?.type === 'machine' ? owner.hostKeyFingerprints : null).toEqual([rotated])
  })
})

describe('connectMachineOrcaServer', () => {
  const offer = (host: string): string =>
    encodePairingOffer({
      v: 2,
      endpoint: `ws://${host}:6768`,
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32, 1).toString('base64')
    })
  const pairing = () => ({
    add: vi.fn<MachinePairing['add']>(async () => ({ ok: true, environment: { id: 'env-new' } })),
    repair: vi.fn<MachinePairing['repair']>(async () => ({
      ok: false,
      kind: 'different-server',
      message: 'This pairing link is for a different server.'
    }))
  })

  it('rejects provider pairing links that point at loopback or the LAN', async () => {
    for (const host of ['127.0.0.1', 'localhost', '192.168.1.20', '10.0.0.5']) {
      const fake = pairing()
      await expect(
        connectMachineOrcaServer(
          fake,
          record(),
          { kind: 'orca-server', pairingCode: offer(host), projectRoot: '/w' },
          undefined
        )
      ).rejects.toThrow('local-network')
      expect(fake.add).not.toHaveBeenCalled()
    }
  })

  it('pairs once, then re-pairs into the same environment and fails closed on a new identity', async () => {
    const fake = pairing()
    const code = offer('sandbox.example.com')
    await expect(
      connectMachineOrcaServer(
        fake,
        record(),
        { kind: 'orca-server', pairingCode: code, projectRoot: '/w' },
        undefined
      )
    ).resolves.toEqual({ runtimeEnvironmentId: 'env-new' })

    const bound = record({ runtimeEnvironmentId: 'env-new' })
    await expect(
      connectMachineOrcaServer(
        fake,
        bound,
        { kind: 'orca-server', pairingCode: code, projectRoot: '/w' },
        pairingCodeSha256(code)
      )
    ).resolves.toEqual({ runtimeEnvironmentId: 'env-new' })
    expect(fake.repair).not.toHaveBeenCalled()

    await expect(
      connectMachineOrcaServer(
        fake,
        bound,
        { kind: 'orca-server', pairingCode: offer('sandbox2.example.com'), projectRoot: '/w' },
        pairingCodeSha256(code)
      )
    ).rejects.toThrow("This machine's Orca server identity changed.")
    expect(fake.repair).toHaveBeenCalledWith(expect.objectContaining({ selector: 'env-new' }))
  })
})
