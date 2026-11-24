// The agents shared with this Orca account: found on Orca Cloud, paired over Orca Relay, and reached by
// the window as hosts of their own. A message to a host that is away is held in Orca Cloud.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  isSharedBotNewChatId,
  newSharedBotChatId,
  SHARED_BOT_HOST_ERRORS,
  type SharedBotHostView
} from '../../../shared/bots/shared-bot-hosts'
import type { RelayClientPlatform } from '../../../shared/remote-runtime/relay/client/relay-client-platform'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RpcResponse } from '../../../shared/remote-runtime/rpc/rpc-response-shape'
import { relayStreamError } from '../../../shared/remote-runtime/relay/client/relay-rpc-streams'
import { SharedBotHostLink } from './shared-bot-host-link'
import {
  newSharedBotHostEntry,
  sharedBotHostKey,
  SharedBotHostStore,
  type SharedBotHostEntry
} from './shared-bot-host-store'
import {
  SharedBotHeldSends,
  sharedBotFailure as failure,
  sharedBotOffline
} from './shared-bot-held-sends'
import { nextPairingStep, pinnedSharedBotOffer, type MineShare } from './shared-bot-pairing'
import type { SharedBotsCloud } from './shared-bots-cloud'
import type { SharedBotHomes } from './shared-bot-home'

// New shares and invites resolve within this; pairing and held messages are read sooner.
const IDLE_POLL_MS = 10 * 60 * 1000
const BUSY_POLL_MS = 30 * 1000

const SessionParams = z.looseObject({ sessionId: z.string() })
const EnvelopeParams = z.looseObject({ envelope: SessionParams })

/** The chat a call names, as `sessionId` or in its mutation envelope. */
const sessionIdOf = (params: unknown): string | undefined =>
  SessionParams.safeParse(params).data?.sessionId ??
  EnvelopeParams.safeParse(params).data?.envelope.sessionId

export type SharedBotHostsDeps = {
  userDataPath: string
  cloud: () => SharedBotsCloud | null
  platform: RelayClientPlatform
  publish: (views: SharedBotHostView[]) => void
  homes: SharedBotHomes
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

  /** Every change to the kept shares so far is on disk. */
  flushed(): Promise<void> {
    return this.store.flushed()
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
              homeWorkspaceId: entry.homeWorkspaceId ?? null,
              link: this.linkFor(entry).current(),
              holds: entry.hostKey !== undefined,
              held: this.held.views(entry)
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
      // Cleared in the same turn as the last check, so a read asked for after it starts anew.
      try {
        do {
          this.refreshAgain = false
          await this.readMine()
        } while (this.refreshAgain)
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  private async readMine(): Promise<void> {
    await this.ready()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const cloud = this.deps.cloud()
    const read = this.held.beginRead()
    const answer = cloud ? await cloud.mine() : null
    // Signed out: the account's shares, keys and links go with it.
    const shares = answer?.ok ? answer.value.shares : answer?.error === 'signed_out' ? [] : null
    const gone = shares ? this.applyMine(shares, read) : []
    await this.deps.homes.settle(gone, this.store)
    if (shares) {
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

  async call(
    environmentId: string,
    method: string,
    params: unknown
  ): Promise<RuntimeRpcResponse<unknown>> {
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
    // A new chat while the host is away: a placeholder until its first held message starts it there.
    if (method === 'bots.session.start' && link !== 'live' && entry.hostKey) {
      return {
        id: method,
        ok: true,
        result: { sessionId: newSharedBotChatId(randomUUID()) },
        _meta: { runtimeId: entry.environmentId }
      }
    }
    // The host doesn't know a placeholder chat yet; nothing of it can be read there.
    if (link !== 'live' || isSharedBotNewChatId(sessionIdOf(params))) {
      return sharedBotOffline(entry, method)
    }
    try {
      return this.withMeta(entry, await this.linkFor(entry).request(method, params))
    } catch {
      // The link closed or timed out under the request: an answer the window can read.
      return sharedBotOffline(entry, method)
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
    if (
      !entry ||
      isSharedBotNewChatId(sessionIdOf(params)) ||
      (await this.reach(entry)) !== 'live'
    ) {
      onResponse(
        entry
          ? sharedBotOffline(entry, method)
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

  /** Sends a held message the host refused again; false when it isn't one, or wasn't held. */
  async sendAgain(environmentId: string, clientMessageId: string): Promise<boolean> {
    await this.ready()
    const entry = this.entryFor(environmentId)
    return entry ? this.held.sendAgain(entry, clientMessageId) : false
  }

  /** Applies the cloud's list; returns the kept shares it no longer lists, now removed. */
  private applyMine(shares: readonly MineShare[], read: number): SharedBotHostEntry[] {
    const current = new Map(shares.map((share) => [share.shareId, share]))
    this.shares = current
    this.held.applyMine(shares)
    const gone = this.store.list().filter((entry) => !current.has(entry.shareId))
    for (const { shareId } of gone) {
      this.links.get(shareId)?.close()
      this.links.delete(shareId)
    }
    this.store.remove(new Set(gone.map((entry) => entry.shareId)))
    for (const share of shares) {
      const entry = this.store.get(share.shareId) ?? newSharedBotHostEntry(share)
      const { hostKey: _hostKey, avatarUrl: _avatar, ...rest } = entry
      const offer = pinnedSharedBotOffer(entry, share)
      const hostKey = sharedBotHostKey({ offer, hostKey: share.hostKey })
      this.store.put({
        ...rest,
        botName: share.botName,
        ownerName: share.ownerName,
        ...(share.avatarUrl ? { avatarUrl: share.avatarUrl } : {}),
        ...(hostKey ? { hostKey } : {}),
        ...(offer ? { offer } : {}),
        held: this.held.settle(entry.held, read)
      })
    }
    return gone
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

  private withMeta(entry: SharedBotHostEntry, response: RpcResponse): RuntimeRpcResponse<unknown> {
    return response.ok
      ? { ...response, _meta: { runtimeId: response._meta?.runtimeId ?? entry.environmentId } }
      : response
  }

  /** Whether `environmentId` names one of these hosts; read once `ready` has settled. */
  reaches(environmentId: string): boolean {
    return this.entryFor(environmentId) !== undefined
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
