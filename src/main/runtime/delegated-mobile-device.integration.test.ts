import type * as WorktreeScanCacheModule from '../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../git/worktrees/catalog/worktree-listing'
import { pairedRuntimeConnectionFromOffer } from '../../shared/remote-runtime/pairing/paired-runtime-connection'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './rpc/server/runtime-rpc'
import { encodePairingOffer, parsePairingCode } from '../../shared/remote-runtime/pairing/pairing'
import type { PairingOffer } from '../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime/remote-runtime-client'
import {
  DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
  type DelegatedMobileDeviceSyncResult
} from '../../shared/delegated-mobile-device-contract'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest,
  waitForWsClose
} from './rpc/server/runtime-rpc-mobile-ws-test-harness'
import { makeStore } from './rpc/server/runtime-rpc-worktree-store-fixtures'
import { partialRuntimeStore } from './orca-runtime-tests/runtime-store-partial-fixture'

vi.mock('../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: facade.listWorktrees
  }
})

vi.mock('../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: facade.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  const createWorktreeListingMocks = () => ({
    listWorktrees: vi.fn().mockResolvedValue([]),
    listWorktreesStrict: vi.fn().mockResolvedValue([])
  })
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

type DelegatedDevice = DelegatedMobileDeviceSyncResult['devices'][number]

describe('pairing.delegatedMobileDevice.sync', () => {
  const cleanups: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  async function startServer(userDataPath = mkdtempSync(join(tmpdir(), 'orca-delegated-'))) {
    const runtime = new OrcaRuntimeService(partialRuntimeStore(makeStore()))
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    cleanups.push(() => server.stop())
    return { server, userDataPath, registry: server.getDeviceRegistry()! }
  }

  function pair(
    server: OrcaRuntimeRpcServer,
    args: Parameters<OrcaRuntimeRpcServer['createPairingOffer']>[0]
  ): PairingOffer {
    const offer = server.createPairingOffer({ address: '127.0.0.1', ...args })
    if (!offer.available) {
      throw new Error('pairing unavailable')
    }
    return parsePairingCode(offer.pairingUrl)!
  }

  function pairDesktop(server: OrcaRuntimeRpcServer, name = 'MacBook'): PairingOffer {
    return pair(server, { name, scope: 'runtime' })
  }

  async function sync(
    desktop: PairingOffer,
    phones: { phoneKey: string; name: string }[]
  ): Promise<DelegatedDevice[]> {
    const response = await sendRemoteRuntimeRequest<DelegatedMobileDeviceSyncResult>(
      pairedRuntimeConnectionFromOffer(desktop),
      DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
      { phones },
      5_000
    )
    if (!response.ok) {
      throw new Error(`sync failed: ${response.error.code} ${response.error.message}`)
    }
    return response.result.devices
  }

  function asPhone(desktop: PairingOffer, device: DelegatedDevice): PairingOffer {
    return {
      ...desktop,
      deviceToken: device.token,
      pairedDeviceId: device.deviceId,
      scope: 'mobile'
    }
  }

  it('cascades a parent revoke to its children only', async () => {
    const { server, registry } = await startServer()
    const desktop = pairDesktop(server)
    const [child] = await sync(desktop, [{ phoneKey: 'phone-a', name: 'A' }])
    // Paired after the first desktop consumed its pending offer; the same phoneKey is scoped per parent.
    const otherDesktop = pairDesktop(server, 'Other Mac')
    const [otherChild] = await sync(otherDesktop, [{ phoneKey: 'phone-a', name: 'A' }])
    expect(otherChild!.deviceId).not.toBe(child!.deviceId)

    const session = await authenticateMobileWsSession(encodePairingOffer(asPhone(desktop, child!)))
    const reader = createEncryptedWsResponseReader(session)
    cleanups.push(() => reader.dispose())
    sendEncryptedWsRequest(session, { id: 's', method: 'status.get' })
    await expect(reader.next('s')).resolves.toMatchObject({ ok: true })
    const closed = waitForWsClose(session.ws)

    expect(server.revokeRuntimeAccess(desktop.pairedDeviceId!)).toBe(true)
    expect(registry.getDevice(child!.deviceId)).toBeNull()
    expect(registry.getDevice(otherChild!.deviceId)).not.toBeNull()
    await closed
  })

  it.each(['bearer', 'fork'] as const)(
    'keeps the ancestors when a %s child cleanup cannot be saved',
    async (kind) => {
      const { server, registry } = await startServer()
      const desktop = pairDesktop(server)
      const parent =
        kind === 'fork'
          ? registry.forkDeviceKey(
              desktop.pairedDeviceId!,
              Buffer.alloc(32, 7).toString('base64'),
              'Fork'
            )
          : registry.getDevice(desktop.pairedDeviceId!)!
      const [child] = registry.upsertDelegatedMobileDevices(parent, [{ phoneKey: 'p', name: 'p' }])
      expect(
        server.setMobileRelayBinding(child!.deviceId, {
          relayHostId: 'host',
          relayDeviceId: child!.deviceId,
          ownerIdentityKey: 'owner'
        })
      ).toBe(true)
      const enqueue = vi.spyOn(server.getRelayRevokeOutbox(), 'enqueue').mockImplementation(() => {
        throw new Error('disk full')
      })
      cleanups.push(() => enqueue.mockRestore())

      expect(server.revokeRuntimeAccess(desktop.pairedDeviceId!)).toBe(false)
      expect(registry.getDevice(desktop.pairedDeviceId!)).not.toBeNull()
      expect(registry.getDevice(parent.deviceId)).not.toBeNull()
      expect(registry.getDevice(child!.deviceId)).not.toBeNull()

      enqueue.mockRestore()
      expect(server.revokeRuntimeAccess(desktop.pairedDeviceId!)).toBe(true)
      expect(registry.getDevice(parent.deviceId)).toBeNull()
      expect(registry.getDevice(child!.deviceId)).toBeNull()
    }
  )
})
