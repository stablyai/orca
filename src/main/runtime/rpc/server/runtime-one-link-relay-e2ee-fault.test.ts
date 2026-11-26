// A paired desktop's one link to its host through the real Relay path: RelayE2eeLink's relay-auth
// and hello with a stand-in cell (the real splice limits), the host's CloudRelayTransport data
// sockets, E2EE token auth that carries the desktop's capabilities, then a resume credential.
// Bursts and a JSON stream share the link, survive a cut (redialed on the resume credential), and
// no frame reaches the wrong stream.
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeSharedControlConnection } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import {
  clearRemoteRuntimeOneLink,
  setRemoteRuntimeOneLink
} from '../../../../shared/remote-runtime/control/remote-runtime-one-link'
import {
  relayRuntimeChannelOpener,
  runtimeRelayLinkEntry
} from '../../../../shared/remote-runtime/control/remote-runtime-relay-authenticated-channel'
import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { runtimeRelayEndpoint } from '../../../../shared/remote-runtime/pairing/runtime-relay-endpoint'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import type { RelayClientPlatform } from '../../../../shared/remote-runtime/relay/client/relay-client-platform'
import type { SharedHostLinkEntry } from '../../../../shared/remote-runtime/relay/client/shared-host-relay-link'
import type { DeviceCredentialInstalled } from '../../../../shared/remote-runtime/relay/mobile-relay-credential-contract'
import { hashRelayCredential } from '../../../../shared/remote-runtime/relay/relay-credential-hash'
import { deriveRelayHostId } from '../../mobile-cloud-relay/director/relay-http-client'
import { STATUS_METHODS } from '../methods/host-management/status'
import { PAIRING_METHODS } from '../methods/pairing/pairing'
import { OrcaRuntimeService } from '../../orca-runtime'
import { CloudRelayTransport } from '../transports/relay-transport'
import {
  burst,
  openBurst,
  runningBursts,
  ticks
} from '../testing/one-link-burst-streams.test-fixtures'
import { startRelayProtocolCellStandIn } from '../testing/relay-protocol-cell-stand-in'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

const INVITE = 'I'.repeat(43)
const CELL_ORIGIN = 'https://cell.test'
// Every expiry in this test is far in the future (2100): only acceptance matters here.
const FAR_FUTURE = 4_102_444_800_000

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  runningBursts.clear()
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

async function startHostOverRelay() {
  vi.stubEnv('ORCA_TEST_RUNTIME_RELAY_PAIRING', '1')
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-link-'))
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    wsPort: 0,
    methods: [...STATUS_METHODS, ...PAIRING_METHODS, burst, ticks]
  })
  await server.start()
  cleanups.push(async () => {
    await server.stop().catch(() => {})
    rmSync(userDataPath, { recursive: true, force: true })
  })
  const offer = server.createPairingOffer({ address: '127.0.0.1', scope: 'runtime', name: 'Desk' })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  const relayHostId = deriveRelayHostId(server.getE2EEKeypair()!.publicKey)
  const relay = {
    v: 1 as const,
    directorUrl: 'https://relay.test',
    cellUrl: CELL_ORIGIN,
    assignmentEpoch: 1,
    relayHostId,
    e2eeFraming: 2 as const
  }
  server.getDeviceRegistry()!.setRelayBinding(offer.deviceId, {
    relayHostId,
    relayDeviceId: offer.deviceId,
    ownerIdentityKey: 'test-owner'
  })
  // The host's Relay service, as far as a desktop's credential install and renewal reach it.
  const installs = new Map<string, DeviceCredentialInstalled>()
  let resumeHash: string | null = null
  server.setMobileRelayPairingProvider({
    createPairingRelay: () => Promise.reject(new Error('not in this test')),
    onDeviceRevokeQueued: () => {},
    provisionRelay: async (_context, params) => {
      const installed: DeviceCredentialInstalled = {
        v: 1,
        reqId: params.reqId,
        authorizationMode: 'relay-basis',
        currentVersion: 1,
        resumeExpiresAt: FAR_FUTURE
      }
      installs.set(params.reqId, installed)
      resumeHash = params.newResumeTokenHash
      return installed
    },
    getEndpoints: async (_context, params) => {
      const installed = params.installReqId ? installs.get(params.installReqId) : undefined
      return {
        v: 1,
        relay,
        ...(params.installReqId
          ? {
              installStatus: installed
                ? { v: 1, reqId: params.installReqId, state: 'committed', result: installed }
                : { v: 1, reqId: params.installReqId, state: 'not-found' }
            }
          : {}),
        ...(params.resumeConfirmReqId
          ? {
              resumeConfirmation: {
                v: 1,
                reqId: params.resumeConfirmReqId,
                currentVersion: 1,
                acceptedAs: 'current',
                renewed: true,
                resumeExpiresAt: FAR_FUTURE
              }
            }
          : {})
      }
    }
  })

  let connections = 0
  let transport: CloudRelayTransport | null = null
  const cell = await startRelayProtocolCellStandIn({
    admit: (credential) => {
      const kind =
        credential === INVITE && resumeHash === null
          ? 'invite'
          : resumeHash !== null && hashRelayCredential(credential) === resumeHash
            ? 'resume'
            : null
      if (!kind || !transport) {
        return null
      }
      const connId = `connection-${++connections}`
      void transport
        .openConnection({
          connId,
          connTicket: 'A'.repeat(43),
          kind,
          relayDeviceId: offer.deviceId,
          attachDeadlineMs: 5_000
        })
        .catch(() => {})
      const leaseExpiresAt = FAR_FUTURE
      return {
        connId,
        hello:
          kind === 'invite'
            ? { type: 'relay-hello', ok: true, credentialKind: 'invite', leaseExpiresAt }
            : {
                type: 'relay-hello',
                ok: true,
                credentialKind: 'resume',
                leaseExpiresAt,
                acceptedCredentialVersion: 1,
                acceptedAs: 'current',
                resumeExpiresAt: leaseExpiresAt
              }
      }
    }
  })
  cleanups.push(() => cell.close())
  const hostTransport = new CloudRelayTransport({
    cellUrl: cell.url.replace('ws:', 'http:'),
    relayHostId,
    generation: 1
  })
  transport = hostTransport
  server
    .getMobileSocketWiring()!
    .attachTransport(hostTransport, (socket) => hostTransport.metadataFor(socket))
  await hostTransport.start()
  cleanups.push(() => hostTransport.stop())

  // The desktop: paired over Relay only, its link dialed through the stand-in cell.
  const direct = pairedRuntimeConnectionFromOffer(parsePairingCode(offer.pairingUrl)!)
  const connection = {
    ...direct,
    endpoint: runtimeRelayEndpoint({
      ...relay,
      inviteToken: INVITE,
      inviteExpiresAt: FAR_FUTURE
    })
  }
  const platform: RelayClientPlatform = {
    ...NODE_RELAY_CLIENT_PLATFORM,
    createSocket: (url, events) =>
      NODE_RELAY_CLIENT_PLATFORM.createSocket(url.replace(/^wss:\/\/[^/]+/, cell.url), events)
  }
  let entry: SharedHostLinkEntry | undefined = runtimeRelayLinkEntry(connection) ?? undefined
  const link = new RemoteRuntimeSharedControlConnection(connection, {
    environmentId: 'relay-link-test',
    binaryChannels: true,
    appHeartbeat: {},
    openChannel: (clientCapabilities) =>
      relayRuntimeChannelOpener(connection, {
        platform,
        store: { entry: () => entry, save: (next) => void (entry = next) },
        clientCapabilities,
        randomBytes: (length) => new Uint8Array(randomBytes(length)),
        newId: randomUUID
      })
  })
  setRemoteRuntimeOneLink('relay-link-test', connection, () => link)
  cleanups.push(() => {
    clearRemoteRuntimeOneLink('relay-link-test')
    link.close()
  })
  return { cell, connection, link, entry: () => entry }
}

describe('one link per host over Relay (RelayE2eeLink)', () => {
  it(
    'pairs on the invite, keeps a resume credential, and resumes every stream after a cut',
    async () => {
      const { cell, connection, link, entry } = await startHostOverRelay()
      expect((await link.request('status.get', { probe: true }, 15_000)).ok).toBe(true)
      expect(entry()?.resume?.version).toBe(1)
      expect(cell.credentials).toEqual([INVITE])

      // Binary channels need the desktop's capabilities on its Relay token auth.
      const streams = await Promise.all([1, 2].map((tag) => openBurst(connection, tag, cleanups)))
      let tickCount = 0
      await link.subscribe('test.ticks', null, 10_000, {
        onResponse: () => {
          tickCount += 1
        },
        onError: () => {}
      })
      await vi.waitFor(() => expect(streams.every((s) => s.frames > 50)).toBe(true), {
        timeout: 20_000
      })

      const before = streams.map((s) => s.frames)
      const ticksBefore = tickCount
      cell.cut()
      await vi.waitFor(
        () => {
          expect(streams.every((s, i) => s.frames > before[i] + 50)).toBe(true)
          expect(tickCount).toBeGreaterThan(ticksBefore + 5)
        },
        { timeout: 30_000 }
      )
      // The redial used the resume credential, not the spent invite.
      expect(cell.credentials).toHaveLength(2)
      expect(cell.credentials[1]).toBe(entry()?.resume?.token)
      expect(streams.map((s) => s.wrong)).toEqual([0, 0])
      expect(streams.map((s) => s.ends)).toEqual([1, 1])
      expect([...runningBursts.entries()].sort()).toEqual([
        [1, 1],
        [2, 1]
      ])
      expect(cell.limitCloses).toEqual([])
      for (const stream of streams) {
        stream.close()
      }
    },
    // A real host through a stand-in cell: pairing, credential install, a cut and a resumed redial.
    90_000
  )
})
