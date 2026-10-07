import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, parsePairingCode, type PairingOffer } from '../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  markEnvironmentUsed
} from '../../shared/runtime-environment-store'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { verifyRuntimePairingIdentity } from '../runtime/runtime-environment-identity-verification'
import { verifyManagedOrcadTunnelIdentity } from './orcad-managed-tunnel-identity'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const servers: OrcaRuntimeRpcServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

/** An orcad process on `userDataPath`, the host profile that holds its E2EE key and devices. */
async function startOrcad(userDataPath: string): Promise<OrcaRuntimeRpcServer> {
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  servers.push(server)
  return server
}

function pairingOffer(server: OrcaRuntimeRpcServer): PairingOffer {
  const offer = server.createPairingOffer({ address: '127.0.0.1', name: 'Desktop A' })
  if (!offer.available) {
    throw new Error('pairing unavailable')
  }
  return parsePairingCode(offer.pairingUrl)!
}

function managedEnvironment(pairing: PairingOffer, runtimeId: string): KnownRuntimeEnvironment {
  return {
    id: 'env-1',
    name: 'Box server',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId,
    preferredEndpointId: 'ws',
    endpoints: [
      {
        id: 'ws',
        kind: 'websocket',
        label: 'Box',
        endpoint: pairing.endpoint,
        deviceToken: pairing.deviceToken,
        publicKeyB64: pairing.publicKeyB64
      }
    ],
    connectionDependency: 'ssh-tunnel',
    orcadDeployment: {
      sshTargetId: 'box',
      sshTargetGeneration: 1,
      localPort: 46_768,
      remotePort: 6_768
    }
  }
}

/** The restarted process listens on a new port; the tunnel's local endpoint reaches it. */
function reachedThrough(pairing: PairingOffer, server: OrcaRuntimeRpcServer): PairingOffer {
  const port = new URL(pairingOffer(server).endpoint).port
  const endpoint = new URL(pairing.endpoint)
  endpoint.port = port
  return { ...pairing, endpoint: endpoint.toString() }
}

describe('reopening a managed tunnel after orcad restarted elsewhere', () => {
  it('accepts the same host under a new runtime id, and its status recovers', async () => {
    const hostProfile = mkdtempSync(join(tmpdir(), 'orcad-host-'))
    const first = await startOrcad(hostProfile)
    const paired = pairingOffer(first)
    const recorded = (await verifyRuntimePairingIdentity(paired, { runtimeId: null }))
      .verifiedRuntimeId
    await first.stop()

    // Another desktop updated or woke the host while this one was away.
    const restarted = await startOrcad(hostProfile)
    const pairing = reachedThrough(paired, restarted)

    await expect(
      verifyManagedOrcadTunnelIdentity(managedEnvironment(pairing, recorded))
    ).resolves.toEqual({ verdict: 'verified' })
    // The first authenticated status reply over the reopened tunnel records the new id.
    const status = await verifyRuntimePairingIdentity(pairing, { runtimeId: null })
    expect(status.verifiedRuntimeId).not.toBe(recorded)
    const desktopProfile = mkdtempSync(join(tmpdir(), 'desktop-a-'))
    const saved = addEnvironmentFromPairingCode(desktopProfile, {
      name: 'Box server',
      pairingCode: encodePairingOffer(pairing)
    })
    markEnvironmentUsed(desktopProfile, saved.id, { runtimeId: recorded })
    markEnvironmentUsed(desktopProfile, saved.id, {
      runtimeId: status.verifiedRuntimeId,
      pairingDeviceToken: pairing.deviceToken
    })
    expect(listEnvironments(desktopProfile)[0]?.runtimeId).toBe(status.verifiedRuntimeId)
  })

  it('still refuses a different host that answers on the tunnel', async () => {
    const paired = pairingOffer(await startOrcad(mkdtempSync(join(tmpdir(), 'orcad-host-'))))
    const other = await startOrcad(mkdtempSync(join(tmpdir(), 'orcad-other-')))

    await expect(
      verifyManagedOrcadTunnelIdentity(
        managedEnvironment(reachedThrough(paired, other), 'runtime-recorded')
      )
    ).resolves.toMatchObject({ verdict: 'foreign' })
  })
})
