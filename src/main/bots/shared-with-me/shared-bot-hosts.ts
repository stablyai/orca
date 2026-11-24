// The agents shared with this Orca account: found on Orca Cloud, paired over Orca Relay, and reached by
// the window as hosts of their own. A message to a host that is away is held in Orca Cloud.
import { openBotTeamShareOffer } from '../../../shared/bots/bot-team-share-seal'
import {
  SHARED_BOT_HOST_ERRORS,
  type SharedBotHostView
} from '../../../shared/bots/shared-bot-hosts'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import type { RelayClientPlatform } from '../../../shared/remote-runtime/relay/client/relay-client-platform'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RpcResponse } from '../../../shared/remote-runtime/rpc/rpc-response-shape'
import { relayStreamError } from '../../../shared/remote-runtime/relay/client/relay-rpc-streams'
import { SharedBotHostLink } from './shared-bot-host-link'
import {
  newSharedBotHostEntry,
  SharedBotHostStore,
  type SharedBotHostEntry
} from './shared-bot-host-store'
import { SharedBotHeldSends, sharedBotFailure as failure } from './shared-bot-held-sends'
import { nextPairingStep, type MineShare } from './shared-bot-pairing'
import type { SharedBotsCloud } from './shared-bots-cloud'

// New shares and invites resolve within this; pairing and held messages are read sooner.
const IDLE_POLL_MS = 10 * 60 * 1000
const BUSY_POLL_MS = 30 * 1000

export type SharedBotHostsDeps = {
  userDataPath: string
  cloud: () => SharedBotsCloud | null
  platform: RelayClientPlatform
  publish: (views: SharedBotHostView[]) => void
  now?: () => number
}

export class SharedBotHosts {
  private readonly store: SharedBotHostStore
  private readonly links = new Map<string, SharedBotHostLink>()
  // Null until the cloud first answers: every kept share is listed meanwhile, none dropped.
  private shares: Map<string, MineShare> | null = null
  private readonly held: SharedBotHeldSends
  private refreshing: Promise<void> | null = null
  private refreshAgain = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number
  private loaded: Promise<void> | null = null

  constructor(private readonly deps: SharedBotHostsDeps) {
    this.store = new SharedBotHostStore(deps.userDataPath)
    this.now = deps.now ?? Date.now
    this.held = new SharedBotHeldSends({
      store: this.store,
      cloud: deps.cloud,
      now: this.now,
      changed: () => {
        this.publish()
        void this.refresh()
      }
    })
  }

  /** The kept shares are loaded, so `views` lists them. */
  ready(): Promise<void> {
    this.loaded ??= this.store.load()
    return this.loaded
  }

  start(): void {
    void this.refresh()
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const link of this.links.values()) {
      link.close()
    }
  }

  views(): SharedBotHostView[] {
    return this.store.list().flatMap((entry) =>
      this.shares === null || this.shares.has(entry.shareId)
        ? [
            {
              environmentId: entry.environmentId,
              shareId: entry.shareId,
              botId: entry.botId,
              botName: entry.botName,
              ownerName: entry.ownerName,
              link: this.linkFor(entry).current()
            }
          ]
        : []
    )
  }

  /** Reads the account's shares, follows each one's pairing, and schedules the next read. One read
   *  at a time: one asked for meanwhile runs once after it, so no older answer lands last. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true
      return this.refreshing
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false
        await this.readMine()
      } while (this.refreshAgain)
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async readMine(): Promise<void> {
    await this.ready()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const cloud = this.deps.cloud()
    const askedAt = this.now()
    const answer = cloud ? await cloud.mine() : null
    // Signed out: the account's shares, keys and links go with it.
    const shares = answer?.ok ? answer.value.shares : answer?.error === 'signed_out' ? [] : null
    if (shares) {
      this.applyMine(shares, askedAt)
      await Promise.all(this.store.list().map((entry) => this.advance(entry)))
    }
    this.publish()
    // Pairing, a held message, or a host away: read again soon, so each settles without a click.
    const busy = this.store
      .list()
      .some(
        (entry) =>
          !entry.resume ||
          this.linkFor(entry).current() !== 'live' ||
          entry.held.some((held) => this.held.isWaiting(held))
      )
    this.timer = setTimeout(() => void this.refresh(), busy ? BUSY_POLL_MS : IDLE_POLL_MS)
    this.timer.unref?.()
  }

  async call(environmentId: string, method: string, params: unknown) {
    await this.ready()
    const entry = this.entryFor(environmentId)
    if (!entry) {
      return failure(method, SHARED_BOT_HOST_ERRORS.offline, 'This agent is no longer shared.')
    }
    const link = await this.reach(entry)
    if (method === 'agentSession.send') {
      const handedOff = await this.held.send(entry, link, params)
      if (handedOff) {
        return handedOff
      }
    }
    if (link !== 'live') {
      return this.offline(entry, method)
    }
    try {
      return this.withMeta(entry, await this.linkFor(entry).request(method, params))
    } catch {
      // The link closed or timed out under the request: an answer the window can read.
      return this.offline(entry, method)
    }
  }

  async subscribe(
    environmentId: string,
    method: string,
    params: unknown,
    onResponse: (response: RuntimeRpcResponse<unknown>) => void
  ): Promise<() => void> {
    await this.ready()
    const entry = this.entryFor(environmentId)
    if (!entry || (await this.reach(entry)) !== 'live') {
      onResponse(
        entry
          ? this.offline(entry, method)
          : failure(method, SHARED_BOT_HOST_ERRORS.offline, 'This agent is no longer shared.')
      )
      return () => {}
    }
    return this.linkFor(entry).subscribe(method, params, (result) => {
      const error = relayStreamError(result)
      onResponse(
        error === null
          ? { id: method, ok: true, result, _meta: { runtimeId: entry.environmentId } }
          : failure(method, SHARED_BOT_HOST_ERRORS.offline, error)
      )
    })
  }

  private applyMine(shares: readonly MineShare[], askedAt: number): void {
    const current = new Map(shares.map((share) => [share.shareId, share]))
    this.shares = current
    this.held.applyMine(shares)
    const gone = new Set(
      this.store
        .list()
        .map((entry) => entry.shareId)
        .filter((shareId) => !current.has(shareId))
    )
    for (const shareId of gone) {
      this.links.get(shareId)?.close()
      this.links.delete(shareId)
    }
    this.store.remove(gone)
    for (const share of shares) {
      const entry = this.store.get(share.shareId) ?? newSharedBotHostEntry(share)
      const { hostKey: _hostKey, avatarUrl: _avatar, ...rest } = entry
      const offer =
        share.offers
          ?.filter((candidate) => candidate.devicePublicKey === entry.deviceKey.publicKeyB64)
          .map((candidate) =>
            openBotTeamShareOffer(NODE_PAIRED_E2EE_PRIMITIVES, {
              sealSecretKey: Buffer.from(entry.sealKey.secretKeyB64, 'base64'),
              sealed: candidate.sealedOffer,
              expect: { botId: share.botId }
            })
          )
          .find((opened) => opened !== null) ?? entry.offer
      this.store.put({
        ...rest,
        botName: share.botName,
        ownerName: share.ownerName,
        ...(share.avatarUrl ? { avatarUrl: share.avatarUrl } : {}),
        ...(share.hostKey ? { hostKey: share.hostKey } : {}),
        ...(offer ? { offer } : {}),
        held: entry.held.filter((held) => this.held.kept(held, askedAt))
      })
    }
  }

  /** Accepts; dials a fresh invite at once so it is spent before it expires, and an online host so
   *  its agent is listed live. */
  private async advance(entry: SharedBotHostEntry): Promise<void> {
    const share = this.shares?.get(entry.shareId)
    if (!share) {
      return
    }
    const step = nextPairingStep(entry, share, this.now())
    if (step.kind === 'accept') {
      const answer = await this.deps.cloud()?.accept(entry.shareId, {
        v: 1,
        devicePublicKey: entry.deviceKey.publicKeyB64,
        sealKey: entry.sealKey.publicKeyB64
      })
      if (answer?.ok) {
        this.store.put({ ...(this.store.get(entry.shareId) ?? entry), acceptedAt: this.now() })
      }
    } else if (step.kind === 'connect' && (step.credential.kind === 'invite' || share.hostOnline)) {
      await this.linkFor(entry).connect(step.credential)
    }
  }

  /** The link once any dial this entry can make has settled. */
  private async reach(entry: SharedBotHostEntry) {
    const link = this.linkFor(entry)
    const share = this.shares?.get(entry.shareId)
    const step = share ? nextPairingStep(entry, share, this.now()) : null
    return step?.kind === 'connect' ? link.connect(step.credential) : link.settled()
  }

  private offline(entry: SharedBotHostEntry, method: string): RuntimeRpcResponse<unknown> {
    return failure(
      method,
      SHARED_BOT_HOST_ERRORS.offline,
      `${entry.ownerName}’s computer is offline`
    )
  }

  private withMeta(entry: SharedBotHostEntry, response: RpcResponse): RuntimeRpcResponse<unknown> {
    return response.ok
      ? { ...response, _meta: { runtimeId: response._meta?.runtimeId ?? entry.environmentId } }
      : response
  }

  private entryFor(environmentId: string): SharedBotHostEntry | undefined {
    return this.store.list().find((entry) => entry.environmentId === environmentId)
  }

  private linkFor(entry: SharedBotHostEntry): SharedBotHostLink {
    let link = this.links.get(entry.shareId)
    if (!link) {
      link = new SharedBotHostLink({
        platform: this.deps.platform,
        entry: () => this.store.get(entry.shareId),
        save: (next) => this.store.put(next),
        onLinkChanged: () => this.publish()
      })
      this.links.set(entry.shareId, link)
    }
    return link
  }

  private publish(): void {
    this.deps.publish(this.views())
  }
}
