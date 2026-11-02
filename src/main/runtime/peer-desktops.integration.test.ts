import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { encodePairingOffer, parsePairingCode, type PairingOffer } from '../../shared/pairing'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime/remote-runtime-client'
import {
  ORCAD_DECLARE_CLIENT_METHOD,
  ORCAD_PEER_DESKTOPS_METHOD,
  type OrcadPeerDesktopsResult
} from '../../shared/orcad-peer-desktops-contract'
import { ORCAD_PEER_DESKTOPS_RUNTIME_CAPABILITY } from '../../shared/orcad-runtime-capabilities'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest,
  waitForWsClose,
  type AuthenticatedMobileWs
} from './runtime-rpc-mobile-ws-test-harness'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { DECLARED_CLIENT_RECONNECT_GRACE_MS } from './declared-desktop-clients'
import { partialRuntimeStore } from './runtime-store-partial-fixture'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const STABLE = 'stable-installation-id'
const DEV = 'dev-installation-id-01'

describe(ORCAD_PEER_DESKTOPS_METHOD, () => {
  const cleanups: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  async function startServer(): Promise<OrcaRuntimeRpcServer> {
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(partialRuntimeStore(makeStore())),
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-peer-desktops-')),
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    cleanups.push(() => server.stop())
    return server
  }

  function pair(server: OrcaRuntimeRpcServer, name: string, scope: 'runtime' | 'mobile') {
    const offer = server.createPairingOffer({ address: '127.0.0.1', name, scope })
    if (!offer.available) {
      throw new Error('pairing unavailable')
    }
    return parsePairingCode(offer.pairingUrl)!
  }

  /** A one-shot socket, as the desktop's Remove uses. */
  function oneShot<T>(offer: PairingOffer, method: string, params?: unknown) {
    return sendRemoteRuntimeRequest<T>(
      pairedRuntimeConnectionFromOffer(offer),
      method,
      params,
      5_000
    )
  }

  /** A long-lived socket; a control socket declares its installation on it. */
  async function socket(offer: PairingOffer) {
    const session: AuthenticatedMobileWs = await authenticateMobileWsSession(
      encodePairingOffer(offer)
    )
    const reader = createEncryptedWsResponseReader(session)
    cleanups.push(() => {
      reader.dispose()
      session.ws.close()
    })
    let next = 0
    const request = async (method: string, params?: unknown) => {
      const id = `r${(next += 1)}`
      sendEncryptedWsRequest(session, { id, method, params })
      return reader.next(id)
    }
    return { session, request }
  }

  async function peerNames(offer: PairingOffer, clientInstanceId: string): Promise<string[]> {
    const answer = await oneShot<OrcadPeerDesktopsResult>(offer, ORCAD_PEER_DESKTOPS_METHOD, {
      clientInstanceId
    })
    if (!answer.ok) {
      throw new Error(answer.error.message)
    }
    return answer.result.peers.map((peer) => peer.name)
  }

  it('advertises the check, and a desktop with control, multiplex and one-shot sockets sees no peers', async () => {
    const server = await startServer()
    const startup = pair(server, 'CLI 10/28/2026', 'runtime')
    const status = await oneShot<RuntimeStatus>(startup, 'status.get')
    expect(status.ok && status.result.capabilities).toContain(
      ORCAD_PEER_DESKTOPS_RUNTIME_CAPABILITY
    )
    const control = await socket(startup)
    expect(
      await control.request(ORCAD_DECLARE_CLIENT_METHOD, { clientInstanceId: STABLE })
    ).toMatchObject({ ok: true })
    // An undeclared second socket (as a terminal multiplex) and one-shot calls are this same desktop.
    await (await socket(startup)).request('status.get')
    expect(await peerNames(startup, STABLE)).toEqual([])
  })

  it('tells two desktops sharing one startup token apart, and keeps one through a reconnect', async () => {
    const server = await startServer()
    const startup = pair(server, 'CLI 10/28/2026', 'runtime')
    const stable = await socket(startup)
    await stable.request(ORCAD_DECLARE_CLIENT_METHOD, { clientInstanceId: STABLE })
    const dev = await socket(startup)
    await dev.request(ORCAD_DECLARE_CLIENT_METHOD, { clientInstanceId: DEV })
    // The startup row's "CLI <date>" name says nothing to a person.
    expect(await peerNames(startup, STABLE)).toEqual(['another Orca'])
    expect(await peerNames(startup, DEV)).toEqual(['another Orca'])

    // Dev's control socket closes: lost contact isn't proof it left, so it still counts while it
    // reconnects (the grace's expiry is unit-tested with a clock).
    // Read only after the server itself dropped the socket, so this proves the grace, not a race.
    const declared = () => server['declaredDesktopClients']['byConnection'].size
    expect(declared()).toBe(2)
    const closed = waitForWsClose(dev.session.ws)
    dev.session.ws.close()
    await closed
    await expect.poll(declared).toBe(1)
    expect(await peerNames(startup, STABLE)).toEqual(['another Orca'])

    // A reconnect declares again.
    const devAgain = await socket(startup)
    await devAgain.request(ORCAD_DECLARE_CLIENT_METHOD, { clientInstanceId: DEV })
    expect(await peerNames(startup, STABLE)).toEqual(['another Orca'])
  })

  it('sanitizes a peer name and ignores phones', async () => {
    const server = await startServer()
    const stable = pair(server, 'Orca', 'runtime')
    await (await socket(stable)).request(ORCAD_DECLARE_CLIENT_METHOD, { clientInstanceId: STABLE })
    const dev = pair(server, 'Orca‮\nDev​', 'runtime')
    await (await socket(dev)).request(ORCAD_DECLARE_CLIENT_METHOD, { clientInstanceId: DEV })
    expect(await peerNames(stable, STABLE)).toEqual(['OrcaDev'])

    const phone = await socket(pair(server, 'Phone', 'mobile'))
    const refused = await phone.request(ORCAD_DECLARE_CLIENT_METHOD, {
      clientInstanceId: 'phone-installation'
    })
    expect(refused.ok).not.toBe(true)
    expect(await peerNames(stable, STABLE)).toEqual(['OrcaDev'])
  })

  // R39 follow-up: Stable removed the host while Dev used it, so the server was kept. Once Stable
  // is gone past the reconnect grace, Dev is the last Orca, and its own Remove may tear down.
  it('lets the last Orca tear down once the other one has been gone past the grace', async () => {
    const server = await startServer()
    const startup = pair(server, 'CLI 10/28/2026', 'runtime')
    const stable = await socket(startup)
    await stable.request(ORCAD_DECLARE_CLIENT_METHOD, { clientInstanceId: STABLE })
    const dev = await socket(startup)
    await dev.request(ORCAD_DECLARE_CLIENT_METHOD, { clientInstanceId: DEV })
    // Stable's Remove: Dev is connected, so the server is kept.
    expect(await peerNames(startup, STABLE)).toEqual(['another Orca'])

    // Stable lets go of the host.
    const declared = () => server['declaredDesktopClients']['byConnection'].size
    const closed = waitForWsClose(stable.session.ws)
    stable.session.ws.close()
    await closed
    await expect.poll(declared).toBe(1)
    // Within the grace, Stable could still be reconnecting, so Dev's Remove keeps the server.
    expect(await peerNames(startup, DEV)).toEqual(['another Orca'])

    const real = performance.now.bind(performance)
    const clock = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => real() + DECLARED_CLIENT_RECONNECT_GRACE_MS)
    try {
      expect(await peerNames(startup, DEV)).toEqual([])
    } finally {
      clock.mockRestore()
    }
  })
})
