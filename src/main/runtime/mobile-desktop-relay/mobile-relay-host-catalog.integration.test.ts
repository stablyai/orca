import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from '../../../shared/delegated-mobile-device-contract'
import { parsePairingCode, type PairingOffer } from '../../../shared/pairing'
import { RUNTIME_PROTOCOL_VERSION } from '../../../shared/protocol-version'
import { sendRemoteRuntimeRequest } from '../../../shared/remote-runtime-client'
import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeHostStatusSnapshot
} from '../../../shared/runtime-host-status'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest
} from '../runtime-rpc-mobile-ws-test-harness'
import { makeStore } from '../runtime-rpc-worktree-store-fixtures'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'

vi.mock('../../git/worktree', () => {
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
})

type Contact = 'live' | 'unreachable'

describe('mobile relay hosts: phone -> desktop lists the servers it shows', () => {
  const cleanups: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  async function startRuntime() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store carries the surface these RPCs read, as in the sibling relay tests.
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-relay-hosts-')),
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    cleanups.push(() => server.stop())
    return server
  }

  function pairingUrl(server: OrcaRuntimeRpcServer, scope: 'mobile' | 'runtime'): string {
    const offer = server.createPairingOffer({ address: '127.0.0.1', name: scope, scope })
    if (!offer.available) {
      throw new Error('pairing unavailable')
    }
    return offer.pairingUrl
  }

  /** The desktop's status snapshot for a server: what its status owner last heard. */
  function snapshot(
    environmentId: string,
    contact: Contact,
    capable: boolean
  ): RuntimeHostStatusSnapshot {
    return {
      environmentId,
      pairingRevision: 1,
      sequence: 1,
      checkedAt: 1,
      status: {
        runtimeId: environmentId,
        rendererGraphEpoch: 0,
        graphStatus: 'ready',
        authoritativeWindowId: null,
        liveTabCount: 0,
        liveLeafCount: 0,
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        capabilities: capable ? [DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY] : []
      },
      verification: contact === 'live' ? 'verified' : 'unavailable',
      transport: contact === 'live' ? 'ready' : 'disconnected'
    }
  }

  async function startTopology() {
    const box = await startRuntime()
    const old = await startRuntime()
    const desktop = await startRuntime()
    const servers = new Map<string, { name: string; pairing: PairingOffer; capable: boolean }>([
      [
        'box',
        { name: 'Box', pairing: parsePairingCode(pairingUrl(box, 'runtime'))!, capable: true }
      ],
      [
        'old',
        { name: 'ThinkPad', pairing: parsePairingCode(pairingUrl(old, 'runtime'))!, capable: false }
      ]
    ])
    const contact = new Map<string, Contact>([
      ['box', 'live'],
      ['old', 'live']
    ])
    const hosts: MobileDesktopRelayHosts = {
      list: () => ({
        environments: [...servers].map(([id, { name }]) => ({
          id,
          name,
          pairingRevision: 1,
          runtimeId: id
        })),
        sshTargetLabels: new Map(),
        sshConnectionStates: new Map(),
        statusByEnvironmentId: new Map(
          [...servers].map(([id, { capable }]) => [
            id,
            runtimeEnvironmentStatusFromSnapshot(snapshot(id, contact.get(id)!, capable))
          ])
        )
      }),
      resolve: async (environmentId) => {
        const server = servers.get(environmentId)
        return server ? { environmentId, fence: 'pairing-1', pairing: server.pairing } : null
      },
      call: (host, method, params) =>
        sendRemoteRuntimeRequest(servers.get(host.environmentId)!.pairing, method, params, 5_000),
      onEnvironmentRetired: () => () => {}
    }
    desktop.setMobileDesktopRelayHosts(hosts)
    const session = await authenticateMobileWsSession(pairingUrl(desktop, 'mobile'))
    const replies = createEncryptedWsResponseReader(session)
    cleanups.push(() => {
      replies.dispose()
      session.ws.close()
    })
    let sequence = 0
    const phoneCall = async (method: string, params?: unknown) => {
      const id = `phone-${++sequence}`
      sendEncryptedWsRequest(session, { id, method, params })
      return z.object({ ok: z.literal(true), result: z.unknown() }).parse(await replies.next(id))
        .result
    }
    return { box, contact, phoneCall }
  }

  it('lists rows live through the desktop, then its last rows as stale once a server is unreachable', async () => {
    const { box, contact, phoneCall } = await startTopology()

    await expect(phoneCall('mobileRelay.hosts.list')).resolves.toEqual({
      hosts: [
        { hostId: 'runtime:box', label: 'Box', health: 'available', relay: 'ready' },
        { hostId: 'runtime:old', label: 'ThinkPad', health: 'available', relay: 'update-needed' }
      ]
    })
    const warm = await phoneCall('mobileRelay.hosts.worktrees', { hostId: 'runtime:box' })
    expect(warm).toMatchObject({
      worktrees: [
        { worktreeId: 'repo-1::/tmp/worktree-a', hostId: 'runtime:box', branch: 'feature/foo' }
      ],
      totalCount: 1,
      stale: false
    })

    // The update-needed server still answers the desktop, so its rows are live.
    await expect(
      phoneCall('mobileRelay.hosts.worktrees', { hostId: 'runtime:old' })
    ).resolves.toMatchObject({
      worktrees: [{ worktreeId: 'repo-1::/tmp/worktree-a', hostId: 'runtime:old' }],
      stale: false
    })

    await box.stop()
    contact.set('box', 'unreachable')
    await expect(phoneCall('mobileRelay.hosts.list')).resolves.toMatchObject({
      hosts: [{ hostId: 'runtime:box', relay: 'unavailable' }, { hostId: 'runtime:old' }]
    })
    const asRecord = z.record(z.string(), z.unknown())
    const offline = asRecord.parse(
      await phoneCall('mobileRelay.hosts.worktrees', { hostId: 'runtime:box' })
    )
    // The last rows exactly as fetched, provenance kept.
    expect(offline).toEqual({ ...asRecord.parse(warm), stale: true })
  })

  it('answers an empty list on a desktop that relays nowhere', async () => {
    const desktop = await startRuntime()
    const session = await authenticateMobileWsSession(pairingUrl(desktop, 'mobile'))
    const replies = createEncryptedWsResponseReader(session)
    cleanups.push(() => {
      replies.dispose()
      session.ws.close()
    })
    sendEncryptedWsRequest(session, { id: 'list', method: 'mobileRelay.hosts.list' })
    await expect(replies.next('list')).resolves.toMatchObject({ ok: true, result: { hosts: [] } })
  })
})
