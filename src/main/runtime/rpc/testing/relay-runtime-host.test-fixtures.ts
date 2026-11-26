// A real host behind a stand-in Relay cell, and a desktop paired to it over Relay only: the cell
// admits the host's invite until a resume credential is installed, then that credential.
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { RemoteRuntimeSharedControlConnection } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import type { RemoteRuntimeSharedControlConnectionOptions } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import {
  clearRemoteRuntimeOneLink,
  setRemoteRuntimeOneLink
} from '../../../../shared/remote-runtime/control/remote-runtime-one-link'
import {
  relayRuntimeChannelOpener,
  runtimeRelayLinkEntry
} from '../../../../shared/remote-runtime/control/remote-runtime-relay-authenticated-channel'
import { RelayRuntimeDialMemory } from '../../../../shared/remote-runtime/control/remote-runtime-relay-dial-memory'
import { MOBILE_RELAY_CLOSE_CODE } from '../../../../shared/remote-runtime/relay/mobile-relay-close-codes'
import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import {
  parseRuntimeRelayEndpoint,
  runtimeRelayEndpoint
} from '../../../../shared/remote-runtime/pairing/runtime-relay-endpoint'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import type { RelayClientPlatform } from '../../../../shared/remote-runtime/relay/client/relay-client-platform'
import type { SharedHostLinkEntry } from '../../../../shared/remote-runtime/relay/client/shared-host-relay-link'
import type { DeviceCredentialInstalled } from '../../../../shared/remote-runtime/relay/mobile-relay-credential-contract'
import { hashRelayCredential } from '../../../../shared/remote-runtime/relay/relay-credential-hash'
import type { RelayRevokeOutboxItem } from '../../mobile-cloud-relay/pairing/relay-revoke-outbox'
import { deriveRelayHostId } from '../../mobile-cloud-relay/director/relay-http-client'
import { STATUS_METHODS } from '../methods/host-management/status'
import { PAIRING_METHODS } from '../methods/pairing/pairing'
import { OrcaRuntimeService } from '../../orca-runtime'
import { CloudRelayTransport } from '../transports/relay-transport'
import { OrcaRuntimeRpcServer } from '../server/runtime-rpc'
import { burst, ticks } from './one-link-burst-streams.test-fixtures'
import { startRelayProtocolCellStandIn } from './relay-protocol-cell-stand-in'
import { controlLinkOptions } from '../../../ipc/runtime-environments/connections/runtime-environment-relay-link'

export const RELAY_TEST_INVITE = 'I'.repeat(43)
const CELL_ORIGIN = 'https://cell.test'
// Every expiry here is far in the future (2100): only acceptance matters.
const FAR_FUTURE = 4_102_444_800_000

export async function startHostOverRelay(
  cleanups: (() => Promise<void> | void)[],
  options: {
    /** Runs once the host committed a resume credential, before its reply leaves. */
    afterInstallCommitted?: () => void
    control?: Partial<RemoteRuntimeSharedControlConnectionOptions>
    /** Dial through main's opener (its one-link decision and cut), not the bare Relay channel. */
    mainOpener?: boolean
    /** Stands in for the Relay director's lookup (the bare channel only; main's asks the real one). */
    resolveRelay?: Parameters<typeof relayRuntimeChannelOpener>[1]['resolveRelay']
    /** The Relay device a dial lands on; the desktop's pairing unless a test names another. */
    relayDeviceId?: () => string
    runtime?: OrcaRuntimeService
  } = {}
) {
  vi.stubEnv('ORCA_TEST_RUNTIME_RELAY_PAIRING', '1')
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-link-'))
  const server = new OrcaRuntimeRpcServer({
    runtime: options.runtime ?? new OrcaRuntimeService(),
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
  const revokesQueued: RelayRevokeOutboxItem[] = []
  const cellState: {
    resumeHash: string | null
    inviteSpent: boolean
    resumeRevoked: boolean
    /** The cell host the director names; a dial to any other host gets 4409 (wrong cell). */
    hostCell: string
    dialedHosts: string[]
    /** The host is away: the cell answers 4404 (host offline) for any credential. */
    hostOffline: boolean
    /** When each dial left, for gaps between them. */
    dialedAt: number[]
  } = {
    resumeHash: null,
    inviteSpent: false,
    resumeRevoked: false,
    hostCell: 'cell.test',
    dialedHosts: [],
    hostOffline: false,
    dialedAt: []
  }
  server.setMobileRelayPairingProvider({
    createPairingRelay: () => Promise.reject(new Error('not in this test')),
    onDeviceRevokeQueued: (item) => void revokesQueued.push(item),
    provisionRelay: async (_context, params) => {
      const installed: DeviceCredentialInstalled = {
        v: 1,
        reqId: params.reqId,
        authorizationMode: 'relay-basis',
        currentVersion: 1,
        resumeExpiresAt: FAR_FUTURE
      }
      installs.set(params.reqId, installed)
      cellState.resumeHash = params.newResumeTokenHash
      cellState.inviteSpent = true
      options.afterInstallCommitted?.()
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
      if (cellState.dialedHosts.at(-1) !== cellState.hostCell) {
        return { closeCode: MOBILE_RELAY_CLOSE_CODE.WRONG_CELL }
      }
      if (cellState.hostOffline) {
        return { closeCode: MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE }
      }
      const kind =
        credential === RELAY_TEST_INVITE && !cellState.inviteSpent
          ? 'invite'
          : !cellState.resumeRevoked &&
              cellState.resumeHash !== null &&
              hashRelayCredential(credential) === cellState.resumeHash
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
          relayDeviceId: options.relayDeviceId?.() ?? offer.deviceId,
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
    endpoint: withoutDirectorIf(
      // Main's opener asks the real director; tests through it name none, so none is reached.
      options.mainOpener === true,
      runtimeRelayEndpoint({
        ...relay,
        inviteToken: RELAY_TEST_INVITE,
        inviteExpiresAt: FAR_FUTURE
      })
    )
  }
  const platform: RelayClientPlatform = {
    ...NODE_RELAY_CLIENT_PLATFORM,
    createSocket: (url, events) => {
      cellState.dialedHosts.push(new URL(url).host)
      cellState.dialedAt.push(performance.now())
      return NODE_RELAY_CLIENT_PLATFORM.createSocket(
        url.replace(/^wss:\/\/[^/]+/, cell.url),
        events
      )
    }
  }
  let entry: SharedHostLinkEntry | undefined = runtimeRelayLinkEntry(connection) ?? undefined
  const memory = new RelayRuntimeDialMemory()
  const link = new RemoteRuntimeSharedControlConnection(connection, {
    environmentId: 'relay-link-test',
    binaryChannels: true,
    appHeartbeat: {},
    ...options.control,
    openChannel: options.mainOpener
      ? controlLinkOptions('relay-link-test', connection, platform).openChannel!
      : (clientCapabilities) =>
          relayRuntimeChannelOpener(connection, {
            platform,
            store: { entry: () => entry, save: (next) => void (entry = next) },
            clientCapabilities,
            randomBytes: (length) => new Uint8Array(randomBytes(length)),
            newId: randomUUID,
            memory,
            resolveRelay: options.resolveRelay
          })
  })
  setRemoteRuntimeOneLink('relay-link-test', connection, () => link)
  cleanups.push(() => {
    clearRemoteRuntimeOneLink('relay-link-test')
    link.close()
  })
  return {
    server,
    deviceId: offer.deviceId,
    cell,
    cellState,
    revokesQueued,
    connection,
    link,
    entry: () => entry,
    setEntry: (next: SharedHostLinkEntry | undefined) => void (entry = next)
  }
}

function withoutDirectorIf(strip: boolean, endpoint: string): string {
  const reach = parseRuntimeRelayEndpoint(endpoint)
  if (!strip || !reach) {
    return endpoint
  }
  const { directorUrl: _directorUrl, ...rest } = reach
  return `orca-relay:${btoa(JSON.stringify(rest))}`
}
