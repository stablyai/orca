import type * as WorktreeScanCacheModule from '../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import '../rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toRelayedRuntimeEnvironmentId } from '../../../shared/relayed-runtime-environment'
import {
  addEnvironmentFromPairingCode,
  resolveEnvironment
} from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  callRelayedRuntimeEnvironment,
  getRelayedRuntimeEnvironmentStatus
} from '../../ipc/runtime-environments/runtime-environment-relayed-transport'
import { closeRemoteRuntimeRequestConnection } from '../../ipc/runtime-environments/runtime-environment-request-connections'
import { TARGET } from './mobile-desktop-relay-phone.test-fixture'
import { createRelayTopology } from './relay-topology.test-fixture'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

vi.mock('../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeScanCacheModule>()),
  listWorktrees: (await getWorktreeOwnerMocks()).listWorktrees
}))

vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: (await getWorktreeOwnerMocks()).listWorktreesStrict
}))

const { getWorktreeOwnerMocks } = vi.hoisted(() => {
  function createWorktreeOwnerMocks() {
    return (async () =>
      (
        await import('../rpc/server/runtime-rpc-worktree-store-fixtures')
      ).createWorktreeListingMocks())()
  }
  let fixture: ReturnType<typeof createWorktreeOwnerMocks> | undefined
  return { getWorktreeOwnerMocks: () => (fixture ??= createWorktreeOwnerMocks()) }
})

describe('mobile desktop relay: relayed environment read from a paired computer', () => {
  const cleanups: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  const { startTopology } = createRelayTopology(cleanups)

  it("reads a server through this computer's own relayed-environment path, never as the relaying desktop", async () => {
    const { host, desktop, handle } = await startTopology()
    const laptopData = mkdtempSync(join(tmpdir(), 'orca-relay-laptop-'))
    const offer = desktop.server.createPairingOffer({
      address: '127.0.0.1',
      name: 'Laptop',
      scope: 'runtime'
    })
    if (!offer.available) {
      throw new Error('pairing unavailable')
    }
    const paired = addEnvironmentFromPairingCode(laptopData, {
      name: 'Desktop',
      pairingCode: offer.pairingUrl
    })
    cleanups.push(() => closeRemoteRuntimeRequestConnection(paired.id))
    const selector = toRelayedRuntimeEnvironmentId({
      ownerEnvironmentId: paired.id,
      ownerPairingRevision: paired.pairingRevision ?? paired.createdAt,
      executionHost: TARGET
    })

    const status = await getRelayedRuntimeEnvironmentStatus(laptopData, selector)
    const agent = await callRelayedRuntimeEnvironment(laptopData, {
      selector,
      method: 'terminal.agentStatus',
      params: { terminal: handle }
    })

    expect(status).toMatchObject({ ok: true, result: { runtimeId: host.runtime.getRuntimeId() } })
    expect(agent).toMatchObject({ ok: true, _meta: { runtimeId: host.runtime.getRuntimeId() } })
    expect(resolveEnvironment(laptopData, paired.id).runtimeId).not.toBe(
      host.runtime.getRuntimeId()
    )
  })
})
