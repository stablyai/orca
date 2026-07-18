import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileRelayUpgradeHostRemovedError } from './host-store'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { MobileRelayCredentialRecovery } from './mobile-relay-credential-recovery'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { HostProfile } from './types'

const { rotateCredential } = vi.hoisted(() => ({ rotateCredential: vi.fn() }))

vi.mock('./mobile-relay-credential-rotation', async (importOriginal) => {
  const original = await importOriginal<typeof import('./mobile-relay-credential-rotation')>()
  return { ...original, rotateMobileRelayCredential: rotateCredential }
})
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}
const host: HostProfile = {
  id: 'host-1',
  name: 'Blue Whale',
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'A'.repeat(44),
  lastConnected: 1,
  relayHostId: relay.relayHostId,
  relay
}
const bundle: MobileRelayCredentialBundle = {
  v: 1,
  hostId: host.id,
  deviceToken: host.deviceToken,
  current: {
    token: 'A'.repeat(43),
    hash: 'B'.repeat(43),
    version: 2,
    expiresAt: Date.now() + 1_000
  }
}

describe('mobile relay credential recovery', () => {
  beforeEach(() => {
    rotateCredential.mockReset()
  })

  it('serializes rotation and reprovision so the repaired bundle wins', async () => {
    let finishRotation!: (value: {
      bundle: MobileRelayCredentialBundle
      relay: typeof relay
    }) => void
    rotateCredential.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRotation = resolve
        })
    )
    const rotatedBundle = {
      ...bundle,
      current: { ...bundle.current, version: 3, expiresAt: Number.MAX_SAFE_INTEGER }
    }
    const repairedBundle = {
      ...bundle,
      current: { ...bundle.current, version: 4, expiresAt: Number.MAX_SAFE_INTEGER }
    }
    const reprovisionRelay = vi.fn(async () => ({ host, bundle: repairedBundle }))
    const recovery = new MobileRelayCredentialRecovery(host, {
      readBundle: vi.fn(async () => bundle),
      writeBundle: vi.fn(async () => {}),
      deleteBundle: vi.fn(async () => {}),
      reprovisionRelay,
      saveHost: vi.fn(async () => {}),
      onLog: vi.fn(),
      now: Date.now,
      randomBytes: (length) => new Uint8Array(length)
    })
    const client = { getActivePath: () => 'lan' } as StableLogicalRpcClient
    await recovery.load()

    const rotating = recovery.rotateIfNeeded(client)
    await vi.waitFor(() => expect(rotateCredential).toHaveBeenCalledOnce())
    const reprovisioning = recovery.reprovision(client)
    await Promise.resolve()

    expect(reprovisionRelay).not.toHaveBeenCalled()
    finishRotation({ bundle: rotatedBundle, relay })
    await rotating
    await reprovisioning

    expect(reprovisionRelay).toHaveBeenCalledOnce()
    expect(recovery.bundle).toEqual(repairedBundle)
  })

  it('keeps durable pending rotation material while serializing resume confirmation', async () => {
    let failRotation!: () => void
    const pendingBundle: MobileRelayCredentialBundle = {
      ...bundle,
      pending: { token: 'C'.repeat(43), hash: 'D'.repeat(43), reqId: 'rotate-pending' }
    }
    rotateCredential.mockImplementationOnce(
      async (args: {
        writeBundle: (value: MobileRelayCredentialBundle) => Promise<void>
        onBundlePersisted?: (value: MobileRelayCredentialBundle) => void
      }) => {
        await args.writeBundle(pendingBundle)
        args.onBundlePersisted?.(pendingBundle)
        await new Promise<never>((_resolve, reject) => {
          failRotation = () => reject(new Error('lost rotation response'))
        })
      }
    )
    const writes: MobileRelayCredentialBundle[] = []
    const recovery = new MobileRelayCredentialRecovery(host, {
      readBundle: vi.fn(async () => bundle),
      writeBundle: vi.fn(async (value) => {
        writes.push(value)
      }),
      deleteBundle: vi.fn(async () => {}),
      reprovisionRelay: vi.fn(async () => null),
      saveHost: vi.fn(async () => {}),
      onLog: vi.fn(),
      now: Date.now,
      randomBytes: (length) => new Uint8Array(length)
    })
    const client = { getActivePath: () => 'lan' } as StableLogicalRpcClient
    await recovery.load()

    const rotating = recovery.rotateIfNeeded(client)
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    const confirming = recovery.recordRelayConnected(2, {
      v: 1,
      reqId: 'confirm-current',
      currentVersion: 2,
      acceptedAs: 'current',
      renewed: true,
      resumeExpiresAt: Number.MAX_SAFE_INTEGER
    })
    await Promise.resolve()

    expect(writes).toHaveLength(1)
    failRotation()
    await rotating
    await confirming

    expect(recovery.bundle?.pending).toEqual(pendingBundle.pending)
    expect(writes.at(-1)?.pending).toEqual(pendingBundle.pending)
  })

  it('deletes a late rotated bundle when the host was removed before persistence', async () => {
    const rotatedBundle: MobileRelayCredentialBundle = {
      ...bundle,
      current: { ...bundle.current, version: 3, expiresAt: Number.MAX_SAFE_INTEGER }
    }
    rotateCredential.mockImplementationOnce(async () => ({ bundle: rotatedBundle, relay }))
    const deleteBundle = vi.fn(async () => {})
    const saveHost = vi.fn(async () => {
      throw new MobileRelayUpgradeHostRemovedError('host removed')
    })
    const dependencies = {
      readBundle: vi.fn(async () => bundle),
      writeBundle: vi.fn(async () => {}),
      deleteBundle,
      reprovisionRelay: vi.fn(async () => null),
      saveHost,
      onLog: vi.fn(),
      now: Date.now,
      randomBytes: (length: number) => new Uint8Array(length)
    }
    const recovery = new MobileRelayCredentialRecovery(host, dependencies)
    await recovery.load()

    await recovery.rotateIfNeeded({ getActivePath: () => 'lan' } as StableLogicalRpcClient)

    expect(saveHost).toHaveBeenCalledOnce()
    expect(deleteBundle).toHaveBeenCalledWith(host.id)
  })
})
