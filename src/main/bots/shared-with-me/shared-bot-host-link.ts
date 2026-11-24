// One relay link to the host of one shared agent: pairs on the host's invite, installs a resume
// credential, then resumes. Requests and streams share the link, as the phone's do.
import { randomBytes, randomUUID } from 'node:crypto'
import nacl from 'tweetnacl'
import type { RpcResponse } from '../../../shared/remote-runtime/rpc/rpc-response-shape'
import { RelayOuterError } from '../../../shared/remote-runtime/relay/client/relay-e2ee-link'
import type { RelayClientPlatform } from '../../../shared/remote-runtime/relay/client/relay-client-platform'
import {
  confirmRelayResume,
  installRelayResumeCredential
} from '../../../shared/remote-runtime/relay/client/relay-resume-credential'
import type { RelayRpcClient } from '../../../shared/remote-runtime/relay/client/relay-rpc-client'
import {
  connectSharedHost,
  type SharedHostRelayCredential
} from '../../../shared/remote-runtime/relay/client/shared-host-relay-connection'
import { mintRelayCredential } from '../../../shared/remote-runtime/relay/relay-credential-hash'
import { MOBILE_RELAY_CLOSE_CODE } from '../../../shared/remote-runtime/relay/mobile-relay-close-codes'
import type { SharedBotHostEntry } from './shared-bot-host-store'
import { withoutRefusedCredential, type SharedBotLink } from './shared-bot-pairing'

export type SharedBotHostLinkDeps = {
  platform: RelayClientPlatform
  entry: () => SharedBotHostEntry | undefined
  save: (entry: SharedBotHostEntry) => void
  onLinkChanged: (link: SharedBotLink) => void
}

type Settled = Exclude<SharedBotLink, 'connecting'>

// A host found away isn't dialed again sooner than this, however many calls ask for it.
const REDIAL_AFTER_OFFLINE_MS = 15_000

export class SharedBotHostLink {
  private client: RelayRpcClient | null = null
  private connecting: Promise<Settled> | null = null
  private link: SharedBotLink = 'unpaired'
  private offlineAt = 0

  constructor(private readonly deps: SharedBotHostLinkDeps) {}

  current(): SharedBotLink {
    return this.link
  }

  /** Dials with `credential` unless already live or dialing; resolves once the dial settles. */
  connect(credential: SharedHostRelayCredential): Promise<Settled> {
    if (this.link === 'live') {
      return Promise.resolve('live')
    }
    if (
      !this.connecting &&
      this.link === 'offline' &&
      Date.now() - this.offlineAt < REDIAL_AFTER_OFFLINE_MS
    ) {
      return Promise.resolve('offline')
    }
    this.connecting ??= this.dial(credential).finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  /** The dial in flight, or how the link stands now. */
  settled(): Promise<Settled> {
    return this.connecting ?? Promise.resolve(this.link === 'connecting' ? 'offline' : this.link)
  }

  request(method: string, params: unknown): Promise<RpcResponse> {
    return this.client
      ? this.client.sendRequest(method, params)
      : Promise.reject(new Error('shared host not connected'))
  }

  subscribe(method: string, params: unknown, listener: (result: unknown) => void): () => void {
    if (!this.client) {
      listener({ type: 'error', message: 'shared host not connected' })
      return () => {}
    }
    return this.client.subscribe(method, params, listener)
  }

  close(): void {
    const { client } = this
    this.client = null
    client?.close()
    this.setLink('unpaired')
  }

  private setLink(link: SharedBotLink): void {
    if (link === 'offline') {
      this.offlineAt = Date.now()
    }
    if (link !== this.link) {
      this.link = link
      this.deps.onLinkChanged(link)
    }
  }

  private dial(credential: SharedHostRelayCredential): Promise<Settled> {
    const entry = this.deps.entry()
    const offer = entry?.offer
    if (!entry || !offer) {
      return Promise.resolve('unpaired')
    }
    this.setLink('connecting')
    const secretKey = Buffer.from(entry.deviceKey.secretKeyB64, 'base64')
    return new Promise<Settled>((resolve) => {
      const client = connectSharedHost(
        {
          platform: this.deps.platform,
          connection: {
            kind: 'shared-host',
            relay: entry.resume?.relay ?? offer.relay,
            hostPublicKeyB64: offer.hostPublicKeyB64,
            deviceId: offer.deviceId,
            relayCredential: credential
          },
          sign: async (message) => nacl.sign.detached(message, secretKey)
        },
        {
          onAuthenticated: () => {
            void this.afterAuthenticated(client, credential).then(
              () => {
                this.setLink('live')
                resolve('live')
              },
              (error: unknown) => {
                console.warn('[shared-agents] could not keep a resume credential', error)
                client.close()
              }
            )
          },
          onClosed: (error, intentional) => {
            if (this.client !== client) {
              resolve('unpaired')
              return
            }
            this.client = null
            const settled = intentional ? 'offline' : this.afterClosed(credential, error)
            this.setLink(settled)
            resolve(settled)
          }
        }
      )
      this.client = client
    })
  }

  /** Invite: install a resume credential for later dials. Resume: renew it with the host. */
  private async afterAuthenticated(
    client: RelayRpcClient,
    credential: SharedHostRelayCredential
  ): Promise<void> {
    const entry = this.deps.entry()
    if (!entry) {
      return
    }
    if (credential.kind === 'resume') {
      if (entry.resume) {
        await confirmRelayResume(client, `confirm-${randomUUID()}`, entry.resume.relay.relayHostId)
      }
      return
    }
    const pending = entry.pendingResume ?? {
      ...mintRelayCredential((length) => new Uint8Array(randomBytes(length))),
      reqId: `share-${randomUUID()}`
    }
    this.deps.save({ ...entry, pendingResume: pending })
    const { installed, relay } = await installRelayResumeCredential(client, pending)
    const { pendingResume: _pending, ...rest } = this.deps.entry() ?? entry
    this.deps.save({
      ...rest,
      resume: {
        token: pending.token,
        hash: pending.hash,
        version: installed.currentVersion,
        relay: { cellUrl: relay.cellUrl, relayHostId: relay.relayHostId }
      }
    })
  }

  /** The host is away (offline), or refused this credential (unpaired until it answers an accept). */
  private afterClosed(credential: SharedHostRelayCredential, error: Error): Settled {
    if (
      error instanceof RelayOuterError &&
      error.code === MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL
    ) {
      const entry = this.deps.entry()
      if (entry) {
        this.deps.save(withoutRefusedCredential(entry, credential))
      }
      return 'unpaired'
    }
    return 'offline'
  }
}
