// The agents shared with this Orca account: found on Orca Cloud, paired over Orca Relay, and reached by
// the window as hosts of their own. A message to a host that is away is held in Orca Cloud.
import type { SharedBotHostFailures } from './shared-bot-host-failures'
import { sharedBotHostView, type SharedBotHostsState } from '../../../shared/bots/shared-bot-hosts'
import type { RelayClientPlatform } from '../../../shared/remote-runtime/relay/client/relay-client-platform'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { sharedBotHostLink, type SharedBotHostLink } from './shared-bot-host-link'
import {
  newSharedBotHostEntry,
  SharedBotHostStore,
  type SharedBotHostEntry
} from './shared-bot-host-store'
import { applySharedBotMine, sharedBotRequests, usableHere } from './shared-bot-mine-apply'
import { namesSharedBotNewChat, SharedBotHeldSends } from './shared-bot-held-sends'
import {
  sharedBotAnswer,
  sharedBotOffline,
  sharedBotStreamAnswer,
  sharedBotUnshared
} from './shared-bot-host-answers'
import { nextPairingStep, sharedBotsPollMs, type MineShare } from './shared-bot-pairing'
import { SerialRerun } from '../../../shared/concurrency/serial-rerun'
import { CloudSharesSupport, type SharedBotsCloud } from './shared-bots-cloud'
import type { SharedBotHomes } from './shared-bot-home'
import { SharedBotPhoneGrants } from './shared-bot-phone-grants'

// How long a call on a dropped link waits for the share list to say whether it was a revoke.
const SHARES_LIST_WAIT_MS = 5000

export type SharedBotHostsDeps = {
  userDataPath: string
  cloud: () => SharedBotsCloud | null
  /** The signed-in Orca account the cloud is read as; null signed out. */
  account: () => string | null
  platform: RelayClientPlatform
  /** Orca Cloud's connector origin, for this computer's phones; null without a cloud. */
  connectorOrigin?: () => string | null
  publish: (state: SharedBotHostsState) => void
  homes: SharedBotHomes
  failures?: SharedBotHostFailures
  now?: () => number
}

export class SharedBotHosts {
  readonly store: SharedBotHostStore
  private readonly links = new Map<string, SharedBotHostLink>()
  // Null until the cloud first answers: every kept share is listed meanwhile, none dropped.
  private shares: Map<string, MineShare> | null = null
  private readonly held: SharedBotHeldSends
  private readonly reads = new SerialRerun((applied) => this.readMine(applied), SHARES_LIST_WAIT_MS)
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number
  private loaded: Promise<void> | null = null
  private stopped = false
  private readonly sharing = new CloudSharesSupport(() => this.deps.account())
  /** This computer's phones' keys to the shared agents. */
  readonly phones: SharedBotPhoneGrants

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
    this.phones = new SharedBotPhoneGrants({
      store: this.store,
      listed: () => this.listed(),
      reach: (entry) => this.reach(entry),
      request: (entry, method, params) => this.linkFor(entry).request(method, params),
      origin: () => deps.connectorOrigin?.() ?? null,
      requests: () => sharedBotRequests(this.store, this.shares),
      answer: (shareId, accept) => (accept ? this.accept(shareId) : this.decline(shareId))
    })
  }

  /** The kept shares are loaded, so `views` lists them. */
  ready(): Promise<void> {
    this.loaded ??= this.store.load()
    return this.loaded
  }

  start(): void {
    this.stopped = false
    void this.refresh()
  }

  /** Nothing reads or applies the cloud's list after this, a read already out included: quitting
   *  must never change the kept shares. */
  stop(): void {
    this.stopped = true
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

  state(): SharedBotHostsState {
    const requests = sharedBotRequests(this.store, this.shares)
    return { hosts: this.views(), sharing: this.sharing.value, requests }
  }

  views(): SharedBotHostsState['hosts'] {
    return this.listed().map((entry) =>
      sharedBotHostView(entry, {
        homeWorkspaceId: entry.homeWorkspaceId ?? null,
        link: this.linkFor(entry).current(),
        holds: entry.hostKey !== undefined,
        held: this.held.views(entry)
      })
    )
  }

  /** The kept shares, but for those the cloud's last answer no longer lists. */
  private listed(): SharedBotHostEntry[] {
    return this.store.list().filter((entry) => this.shares?.has(entry.shareId) ?? true)
  }

  /** Reads the account's shares, follows each one's pairing, and schedules the next read. One read
   *  at a time: one asked for meanwhile runs once after it, so no older answer lands last. */
  refresh(): Promise<void> {
    // A sign-out or switch hides sharing now, not after a read still out for the last account.
    this.sharing.forgetIfSwitched(() => this.publish())
    return this.reads.start()
  }

  /** The entry and its link, or null once its share is gone. A link that dropped may be a revoke,
   *  so the cloud read that started lands first. */
  private async reachShared(environmentId: string) {
    const entry = this.entryFor(environmentId)
    const link = entry && (await this.reach(entry))
    if (link && link !== 'live') {
      await this.settled()
    }
    return entry && link && this.entryFor(environmentId) ? { entry, link } : null
  }

  private async readMine(applied: () => void): Promise<void> {
    await this.ready()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const read = this.held.beginRead()
    const answer = this.stopped
      ? null
      : await this.sharing.read(this.deps.cloud(), () => this.publish())
    if (this.stopped) {
      applied()
      return
    }
    // Signed out: the account's shares, keys and links go with it. Any other failure keeps them.
    const shares = this.sharing.sharesIn(answer)
    const gone = shares ? this.applyMine(shares, read) : []
    applied()
    await this.deps.homes.settle(gone, this.store)
    if (shares) {
      await Promise.all(this.store.list().map((entry) => this.advance(entry)))
    }
    this.publish()
    if (!this.stopped) {
      const waitMs = sharedBotsPollMs(this.store.list(), (entry) => ({
        link: this.linkFor(entry).current(),
        waiting: entry.held.some((held) => this.held.isWaiting(held))
      }))
      this.timer = setTimeout(() => void this.refresh(), waitMs)
      this.timer.unref?.()
    }
  }

  async call(
    environmentId: string,
    method: string,
    params: unknown
  ): Promise<RuntimeRpcResponse<unknown>> {
    await this.ready()
    const reached = await this.reachShared(environmentId)
    if (!reached) {
      return sharedBotUnshared(method)
    }
    const { entry, link } = reached
    if (method === 'agentSession.send') {
      const handedOff = await this.held.send(entry, link, params)
      if (handedOff) {
        return handedOff
      }
    }
    const local = this.held.answerHere(entry, link, method, params)
    if (local) {
      return local
    }
    // The host doesn't know a placeholder chat yet; nothing of it can be read there.
    if (link !== 'live' || namesSharedBotNewChat(params)) {
      return sharedBotOffline(entry, method)
    }
    try {
      const link = this.linkFor(entry)
      const response =
        method === 'agentSession.send'
          ? await this.held.sendWithKept(params, (sent, args) => link.request(sent, args))
          : await link.request(method, params)
      this.held.noteAnswer(entry, method, params, response)
      return sharedBotAnswer(entry, response)
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
    const reached = await this.reachShared(environmentId)
    if (!reached || namesSharedBotNewChat(params) || reached.link !== 'live') {
      onResponse(reached ? sharedBotOffline(reached.entry, method) : sharedBotUnshared(method))
      return () => {}
    }
    const { entry } = reached
    return this.linkFor(entry).subscribe(method, params, (result) =>
      onResponse(sharedBotStreamAnswer(entry, method, result))
    )
  }

  /** Sends a held message the host refused again; false when it isn't one, or wasn't held. */
  async sendAgain(environmentId: string, clientMessageId: string): Promise<boolean> {
    await this.ready()
    const entry = this.entryFor(environmentId)
    return entry ? this.held.sendAgain(entry, clientMessageId) : false
  }

  /** Applies the cloud's list; returns the kept shares it no longer lists, now removed. */
  private applyMine(shares: readonly MineShare[], read: number): SharedBotHostEntry[] {
    this.shares = new Map(shares.map((share) => [share.shareId, share]))
    const closeLink = (shareId: string) => {
      this.links.get(shareId)?.close()
      this.links.delete(shareId)
    }
    return applySharedBotMine({ store: this.store, held: this.held, closeLink }, shares, read)
  }

  /** Accept: keeps the share and runs its accept and pairing; false when it isn't offered now. */
  async accept(shareId: string): Promise<boolean> {
    await this.ready()
    const share = this.shares?.get(shareId)
    // Declined here, it stays declined: the cloud may list it until it hears, or never (an older cloud).
    if (!share || !usableHere(this.store, shareId)) {
      return false
    }
    this.store.put(this.store.get(shareId) ?? newSharedBotHostEntry(share))
    await this.refresh()
    return true
  }

  /** Decline: kept, so it is never offered again, and told to the cloud for the owner. */
  async decline(shareId: string): Promise<boolean> {
    await this.ready()
    if (!this.shares?.has(shareId) || this.store.get(shareId)) {
      return false
    }
    this.store.decline(shareId, this.now())
    this.publish()
    await this.deps.cloud()?.decline(shareId)
    return true
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
      const link = await this.linkFor(entry).connect(step.credential)
      this.deps.failures?.linked(entry.shareId, link, share.hostOnline)
      await this.phones.endRemoved(entry.shareId)
    }
  }

  /** The link once any dial this entry can make has settled. */
  private async reach(entry: SharedBotHostEntry) {
    const link = this.linkFor(entry)
    const share = this.shares?.get(entry.shareId)
    const step = share ? nextPairingStep(entry, share, this.now()) : null
    return step?.kind === 'connect' ? link.connect(step.credential) : link.settled()
  }

  /** Once a cloud read under way or asked for has its list applied (not its pairings), capped. */
  async settled(): Promise<void> {
    await this.reads.nextListed()
  }

  /** Whether `environmentId` names one of these hosts; read once `ready` has settled. */
  reaches(environmentId: string): boolean {
    return this.entryFor(environmentId) !== undefined || this.store.wasRemoved(environmentId)
  }

  private entryFor(environmentId: string): SharedBotHostEntry | undefined {
    return this.store.list().find((entry) => entry.environmentId === environmentId)
  }

  private linkFor(entry: SharedBotHostEntry): SharedBotHostLink {
    let link = this.links.get(entry.shareId)
    if (!link) {
      link = sharedBotHostLink({
        platform: this.deps.platform,
        entry: () => this.store.get(entry.shareId),
        save: (next) => this.store.put(next),
        // The host refused this device, or dropped it while live (a revoke closes it): the cloud says.
        onLinkChanged: (next, previous) => {
          this.publish()
          if (next === 'unpaired' || (previous === 'live' && next === 'offline')) {
            void this.refresh()
          }
        }
      })
      this.links.set(entry.shareId, link)
    }
    return link
  }

  private publish(): void {
    this.deps.publish(this.state())
  }
}
