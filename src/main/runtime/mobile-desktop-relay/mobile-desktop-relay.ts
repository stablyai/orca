import { pairedRuntimeConnectionFromOffer } from '../../../shared/paired-runtime-connection'
import { randomUUID } from 'node:crypto'
import type { RpcRequest } from '../rpc/core'
import type { DelegatedMobileDeviceSyncParams } from '../../../shared/delegated-mobile-device-contract'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime-client-error'
import {
  openRemoteRuntimePassthroughSocket,
  type RemoteRuntimePassthroughSocket
} from '../../../shared/remote-runtime/remote-runtime-passthrough-socket'
import { DelegatedPhoneGrantCache } from './delegated-phone-grant-cache'
import { localHostedBrowserPageRequest } from './hosted-browser-page-route'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import { RELAYED_STREAM_CARRIERS } from './relayed-stream-carriers'
import {
  declareRelayedPhoneCapabilities,
  RelayedPhoneReplies,
  relayedPhoneCapabilities,
  rewriteRelayedPhoneRequest,
  withRelayedLaunchChatDefault
} from './relayed-phone-frames'

const RELAY_CONNECT_TIMEOUT_MS = 15_000

/** The phone connection a relayed request arrived on. */
export type RelayedPhone = {
  connectionId: string
  deviceId: string
  deviceToken: string
  clientCapabilities: () => readonly RuntimeCapability[]
  reply: (frame: string) => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
}

type OpenedRelayLink = { socket: RemoteRuntimePassthroughSocket; hostToken: string }

class RelayLink {
  readonly replies: RelayedPhoneReplies
  readonly opened: Promise<OpenedRelayLink>

  constructor(
    readonly environmentId: string,
    readonly phone: RelayedPhone,
    allocateStreamId: () => number,
    open: (link: RelayLink) => Promise<OpenedRelayLink>
  ) {
    this.replies = new RelayedPhoneReplies(allocateStreamId)
    this.opened = open(this)
  }
}

/**
 * Relays a phone request carrying `executionHost: runtime:<env>` to that configured server, over one
 * socket per (phone connection, server) signed in as the phone's delegated device (minted by
 * `pairing.delegatedMobileDevice.sync`, tokens held in memory only). Contract:
 * - The desktop never interprets replies; it renumbers only host stream ids (RELAYED_STREAM_CARRIERS).
 * - Upstream, the phone's desktop token is swapped wherever it appears, not per field.
 * - Only `execution-host` methods (MOBILE_RPC_METHOD_ROUTES) reach here; `paired-desktop` ones run locally.
 * - A server without the delegated-devices capability is `update-needed`; nothing relays to it.
 * - A server-side revoke of a phone is final until the next sync.
 */
export class MobileDesktopRelay {
  private readonly links = new Map<string, RelayLink>()
  private readonly grants: DelegatedPhoneGrantCache
  private readonly stopRetirementWatch: () => void

  constructor(
    private readonly options: {
      hosts: MobileDesktopRelayHosts
      listPhones: () => DelegatedMobileDeviceSyncParams['phones']
      allocateStreamId: () => number
      /** Whether this desktop's settings open `agent` as a chat. */
      nativeChatDefault: (agent: string) => boolean
    }
  ) {
    this.grants = new DelegatedPhoneGrantCache(options.hosts, options.listPhones)
    this.stopRetirementWatch = options.hosts.onEnvironmentRetired((environmentId) =>
      this.retireEnvironment(environmentId)
    )
  }

  dispose(): void {
    this.stopRetirementWatch()
    for (const link of this.links.values()) {
      this.endLink(link, unavailable('The paired desktop stopped relaying.'))
    }
    this.grants.clear()
  }

  /** The request to run on this desktop instead, when it renders the page the call targets. */
  localRequestFor(request: RpcRequest, environmentId: string): RpcRequest | null {
    return localHostedBrowserPageRequest(
      request,
      environmentId,
      this.options.hosts.hostsBrowserPage
    )
  }

  forward(
    phone: RelayedPhone,
    environmentId: string,
    request: { id: string; method: string },
    frame: string
  ): void {
    if (RELAYED_STREAM_CARRIERS.get(request.method) === 'phone-binary-frames') {
      phone.reply(
        failure(
          request.id,
          'forbidden',
          `Method '${request.method}' is driven by binary frames, which the desktop does not relay`
        )
      )
      return
    }
    const link = this.linkFor(phone, environmentId)
    link.replies.noteForwarded(request.id)
    link.opened.then(
      ({ socket, hostToken }) => {
        // Why: a link ended while opening already answered this request; never send it late.
        if (!this.isCurrent(link)) {
          return
        }
        const outgoing = withRelayedLaunchChatDefault(
          rewriteRelayedPhoneRequest(frame, phone.deviceToken, hostToken),
          request.method,
          this.options.nativeChatDefault
        )
        if (!socket.send(outgoing)) {
          this.endLink(link, unavailable('The server connection could not take the request.'))
        }
      },
      () => {
        // The open failure already answered every request queued on this link.
      }
    )
  }

  /** Mirrors a phone's capability update to every server socket that phone has open. */
  forwardClientCapabilities(connectionId: string, frame: string): void {
    for (const link of this.links.values()) {
      if (link.phone.connectionId !== connectionId) {
        continue
      }
      // Why a fresh id: the phone already has the desktop's answer to its own id.
      const id = `relay-capabilities:${randomUUID()}`
      link.replies.noteForwarded(id, { swallowReplies: true })
      link.opened.then(
        ({ socket, hostToken }) => {
          if (
            this.isCurrent(link) &&
            !socket.send(
              declareRelayedPhoneCapabilities(
                rewriteRelayedPhoneRequest(frame, link.phone.deviceToken, hostToken, id)
              )
            )
          ) {
            this.endLink(link, unavailable('The server connection could not take the request.'))
          }
        },
        () => {}
      )
    }
  }

  closePhoneConnection(connectionId: string): void {
    for (const link of this.links.values()) {
      if (link.phone.connectionId === connectionId) {
        this.endLink(link, null)
      }
    }
  }

  /** The server was removed, re-paired or disconnected: drop its sockets and grants. */
  retireEnvironment(environmentId: string): void {
    this.grants.delete(environmentId)
    for (const link of this.links.values()) {
      if (link.environmentId === environmentId) {
        this.endLink(link, unavailable('The server connection was reset.'))
      }
    }
  }

  /** The desktop's paired phones changed: re-sync every server already holding grants. */
  phonesChanged(): void {
    for (const environmentId of this.grants.environmentIds()) {
      this.grants.delete(environmentId)
      void this.resync(environmentId)
    }
  }

  private async resync(environmentId: string): Promise<void> {
    try {
      const host = await this.options.hosts.resolve(environmentId)
      if (host) {
        await this.grants.get(host, null)
      }
    } catch {
      // An unreachable server syncs again on its next relayed request.
    }
  }

  private linkFor(phone: RelayedPhone, environmentId: string): RelayLink {
    const key = linkKey(phone.connectionId, environmentId)
    const existing = this.links.get(key)
    if (existing) {
      return existing
    }
    const link = new RelayLink(environmentId, phone, this.options.allocateStreamId, (opening) =>
      this.open(opening)
    )
    link.opened.catch((error: unknown) => {
      this.endLink(
        link,
        error instanceof RemoteRuntimeClientError ? error : unavailable(String(error))
      )
    })
    this.links.set(key, link)
    return link
  }

  private async open(link: RelayLink): Promise<OpenedRelayLink> {
    const { phone } = link
    const host = await this.options.hosts.resolve(link.environmentId)
    if (!host) {
      throw unavailable('The server is not configured on this computer.')
    }
    const grants = await this.grants.get(host, phone.deviceId)
    if (grants.kind === 'update-needed') {
      throw unavailable('The server needs an Orca update to open its workspaces from a phone.')
    }
    // Why: the phone left or the server was retired while syncing; open nothing for it.
    if (!this.isCurrent(link)) {
      throw unavailable('The relayed request was cancelled.')
    }
    const grant = grants.grants.get(phone.deviceId)
    if (!grant || grants.refused.has(phone.deviceId)) {
      throw unavailable('The server does not accept this phone.')
    }
    try {
      const socket = await openRemoteRuntimePassthroughSocket(
        {
          ...pairedRuntimeConnectionFromOffer(host.pairing),
          credential: { kind: 'token', deviceToken: grant.token },
          pairedDeviceId: grant.deviceId
        },
        relayedPhoneCapabilities(phone.clientCapabilities()),
        {
          onText: (plaintext) => {
            const frame = link.replies.text(plaintext)
            if (frame !== null) {
              phone.reply(frame)
            }
          },
          onBinary: (bytes) => {
            const frame = link.replies.binary(bytes)
            if (frame) {
              phone.sendBinary(frame)
            }
          },
          onClose: (error) => this.endLink(link, error)
        },
        { timeoutMs: RELAY_CONNECT_TIMEOUT_MS }
      )
      return { socket, hostToken: grant.token }
    } catch (error) {
      if (error instanceof RemoteRuntimeClientError && error.code === 'unauthorized') {
        // Why: retrying a revoked token would only raise the host's "unpaired device" prompt.
        grants.refused.add(phone.deviceId)
        throw unavailable('The server revoked this phone.')
      }
      throw error
    }
  }

  private isCurrent(link: RelayLink): boolean {
    return this.links.get(linkKey(link.phone.connectionId, link.environmentId)) === link
  }

  private endLink(link: RelayLink, error: RemoteRuntimeClientError | null): void {
    if (!this.isCurrent(link)) {
      return
    }
    this.links.delete(linkKey(link.phone.connectionId, link.environmentId))
    link.opened.then(
      ({ socket }) => socket.close(),
      () => {}
    )
    const openRequestIds = link.replies.takeOpenRequestIds()
    if (error) {
      for (const id of openRequestIds) {
        link.phone.reply(failure(id, error.code, error.message))
      }
    }
  }
}

function linkKey(connectionId: string, environmentId: string): string {
  return `${connectionId}\0${environmentId}`
}

function unavailable(message: string): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError('remote_runtime_unavailable', message)
}

function failure(id: string, code: string, message: string): string {
  return JSON.stringify({ id, ok: false, error: { code, message }, _meta: { runtimeId: null } })
}
