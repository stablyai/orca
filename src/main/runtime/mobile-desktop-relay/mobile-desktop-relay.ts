import { PHONE_RELAY_CONNECT_BUDGET_MS } from '../../../shared/remote-runtime/recipe-vm-wake'
import { verifyRelayedGitHubAuthority } from './relay-github-authority'
import { createRelayedBrowserTab } from './relayed-browser-tab-create'
import { GITHUB_EXACT_OPERATION_UNSUPPORTED } from '../../../shared/github/work-item-target'
import { pairedRuntimeConnectionFromOffer } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { randomUUID } from 'node:crypto'
import type { RpcRequest } from '../rpc/core'
import type { DelegatedMobileDeviceSyncParams } from '../../../shared/delegated-mobile-device-contract'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import { openRemoteRuntimePassthroughSocket } from '../../../shared/remote-runtime/remote-runtime-passthrough-socket'
import {
  failure,
  linkKey,
  RelayLink,
  unavailable,
  type OpenedRelayLink,
  type RelayedPhone
} from './mobile-desktop-relay-link'
import { DelegatedPhoneGrantCache } from './delegated-phone-grant-cache'
import { localHostedBrowserPageRequest } from './hosted-browser-page-route'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import { RELAYED_STREAM_CARRIERS } from './relayed-stream-carriers'
import {
  declareRelayedPhoneCapabilities,
  relayedPhoneCapabilities,
  rewriteRelayedPhoneRequest,
  withRelayedLaunchChatDefault
} from './relayed-phone-frames'

const RELAY_CONNECT_TIMEOUT_MS = PHONE_RELAY_CONNECT_BUDGET_MS

/** One socket per (phone connection, configured server), authenticated with memory-only delegated phone grants.
 * Forward execution-host methods only; old servers require an update, and revocation lasts until the next sync.
 * Replies stay opaque except stream-id renumbering; replace every upstream desktop-token occurrence. */
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
      prepareBrowserHost?: (host: MobileDesktopRelayHost) => Promise<string | null>
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

  localRequestFor(request: RpcRequest, environmentId: string): RpcRequest | null {
    const { hostsBrowserPage } = this.options.hosts
    return localHostedBrowserPageRequest(request, environmentId, hostsBrowserPage)
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
    const link = this.linkFor(phone, environmentId, request.method)
    link.replies.noteForwarded(request.id, {
      browserScreencast:
        request.method === 'status.get'
          ? () => Boolean(this.options.hosts.browserHostClientId?.(environmentId))
          : undefined
    })
    link.opened.then(
      async ({ socket, hostToken, host }) => {
        // An opening link may already have ended and answered; never send its request late.
        if (!this.isCurrent(link)) {
          return
        }
        const outgoing = withRelayedLaunchChatDefault(
          rewriteRelayedPhoneRequest(frame, phone.deviceToken, hostToken),
          request.method,
          this.options.nativeChatDefault
        )
        try {
          if (request.method === 'status.get') {
            await this.options.prepareBrowserHost?.(host)
          }
          if (
            request.method === 'browser.tabCreate' &&
            (await createRelayedBrowserTab({
              hosts: this.options.hosts,
              prepareBrowserHost: this.options.prepareBrowserHost,
              link,
              frame: outgoing,
              socket,
              isCurrent: () => this.isCurrent(link),
              timeoutMs: RELAY_CONNECT_TIMEOUT_MS
            }))
          ) {
            return
          }
          const verification = verifyRelayedGitHubAuthority({
            method: request.method,
            frame: outgoing,
            socket,
            replies: link.replies,
            isCurrent: () => this.isCurrent(link),
            timeoutMs: RELAY_CONNECT_TIMEOUT_MS
          })
          if (verification) {
            await verification
          }
          if (!this.isCurrent(link)) {
            return
          }
        } catch (error) {
          if (this.isCurrent(link)) {
            const reply = link.replies.text(
              failure(
                request.id,
                request.method === 'browser.tabCreate' ||
                  request.method === 'status.get' ||
                  (error instanceof Error && error.message === GITHUB_EXACT_OPERATION_UNSUPPORTED)
                  ? 'remote_runtime_unavailable'
                  : 'runtime_source_mismatch',
                error instanceof Error
                  ? error.message
                  : 'Unable to confirm the executing Orca server.'
              )
            )
            if (reply) {
              phone.reply(reply)
            }
          }
          return
        }
        if (!socket.send(outgoing)) {
          this.endLink(link, unavailable('The server connection could not take the request.'))
        }
      },
      () => {}
    )
  }

  /** Mirrors a phone's capability update to every server socket that phone has open. */
  forwardClientCapabilities(connectionId: string, frame: string): void {
    for (const link of this.links.values()) {
      if (link.phone.connectionId !== connectionId) {
        continue
      }
      // The phone already has the desktop reply for its original id.
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

  retireEnvironment(environmentId: string): void {
    this.grants.delete(environmentId)
    for (const link of this.links.values()) {
      if (link.environmentId === environmentId) {
        link.retire(() => this.endLink(link, unavailable('The server connection was reset.')))
      }
    }
  }

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
    } catch {}
  }

  // The request that opens a link decides whether it may wake a recipe VM behind the server.
  private linkFor(phone: RelayedPhone, environmentId: string, method: string): RelayLink {
    const existing = this.links.get(linkKey(phone.connectionId, environmentId))
    if (
      existing?.carries(method, this.options.hosts, (refusal) => this.endLink(existing, refusal))
    ) {
      return existing
    }
    const link = new RelayLink(environmentId, phone, this.options.allocateStreamId, (opening) =>
      this.open(opening, method)
    )
    link.opened.catch((error: unknown) => {
      this.endLink(
        link,
        error instanceof RemoteRuntimeClientError ? error : unavailable(String(error))
      )
    })
    this.links.set(linkKey(phone.connectionId, environmentId), link)
    return link
  }

  private async open(link: RelayLink, openingMethod: string): Promise<OpenedRelayLink> {
    const { phone } = link
    const host = await link.setup.within(link.prepare(this.options.hosts, openingMethod))
    if (!host) {
      throw unavailable('The server is not configured on this computer.')
    }
    // One budget covers the whole open, so a phone's open still answers in time.
    const grants = await link.setup.within(this.grants.get(host, phone.deviceId))
    if (grants.kind === 'update-needed') {
      throw unavailable('The server needs an Orca update to open its workspaces from a phone.')
    }
    // Sync can outlive phone departure or server retirement; never open a stale link.
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
          ...(host.edgeAuth ? { edgeAuth: host.edgeAuth } : {}),
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
        { timeoutMs: link.setup.remaining() }
      )
      if (!this.isCurrent(link)) {
        socket.close()
        throw unavailable('The relayed request was cancelled.')
      }
      return { socket, hostToken: grant.token, host }
    } catch (error) {
      if (error instanceof RemoteRuntimeClientError && error.code === 'unauthorized') {
        // Retrying revoked tokens would repeatedly raise the host unpaired-device prompt.
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
    link.abortController.abort()
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
