import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import { DEVICE_REGISTRY_FILENAME } from './pairing/mobile-pairing-files'
import '../../../../shared/remote-runtime/host-store/runtime-e2ee-keypair-file'
import '../methods/host-management/status'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: listings.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listings.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  function createWorktreeListingMocks() {
    const worktrees = [
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/foo',
        isBare: false,
        isMainWorktree: false
      }
    ]
    return {
      listWorktrees: vi.fn().mockResolvedValue(worktrees),
      listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
    }
  }
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

describe('OrcaRuntimeRpcServer', () => {
  it('gives a copy started with another ORCA_INSTANCE_ID its own key and drops copied tokens', async () => {
    const pairingFrom = async (userDataPath: string, instanceId: string) => {
      vi.stubEnv('ORCA_INSTANCE_ID', instanceId)
      const server = new OrcaRuntimeRpcServer({
        methods: [],
        runtime: new OrcaRuntimeService(),
        userDataPath,
        enableWebSocket: true,
        wsPort: 0
      })
      await server.start()
      const offer = server.createPairingOffer({ name: 'Clone test' })
      return { server, parsed: offer.available ? parsePairingCode(offer.pairingUrl) : null }
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const source = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const clone = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    try {
      const original = await pairingFrom(source, 'vm-a')
      await original.server.stop()
      const sourceToken = original.parsed?.deviceToken ?? ''
      expect(sourceToken).toBeTruthy()
      cpSync(source, clone, { recursive: true })

      const cloned = await pairingFrom(clone, 'vm-b')
      expect(cloned.parsed?.publicKeyB64).toBeTruthy()
      expect(cloned.parsed?.publicKeyB64).not.toBe(original.parsed?.publicKeyB64)
      expect(cloned.server.getDeviceRegistry()?.validateToken(sourceToken)).toBeNull()
      await cloned.server.stop()

      const restarted = await pairingFrom(source, 'vm-a')
      expect(restarted.parsed?.publicKeyB64).toBe(original.parsed?.publicKeyB64)
      expect(restarted.server.getDeviceRegistry()?.validateToken(sourceToken)).not.toBeNull()
      await restarted.server.stop()
    } finally {
      vi.unstubAllEnvs()
      errorSpy.mockRestore()
    }
  })

  it('reports a registry persistence failure without retaining a ghost credential', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    mkdirSync(join(userDataPath, DEVICE_REGISTRY_FILENAME))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      expect(server.createPairingOffer({ name: 'Registry failure test' })).toMatchObject({
        available: false,
        reason: 'device_registry_unavailable',
        guidance: expect.any(String)
      })
      expect(server.getDeviceRegistry()?.listDevices()).toHaveLength(0)
    } finally {
      errorSpy.mockRestore()
      await server.stop()
    }
  })
})
