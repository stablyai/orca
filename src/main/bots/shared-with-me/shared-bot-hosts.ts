// The agents shared with this Orca account: found on Orca Cloud, paired over Orca Relay, and reached by
// the window as hosts of their own. A message to a host that is away is held in Orca Cloud.
import type { SharedBotHostFailures } from './shared-bot-host-failures'
import {
  SHARED_HOSTS_HOLD_WHILE_AWAY,
  sharedBotHostView,
  type SharedBotHostsState
} from '../../../shared/bots/shared-bot-hosts'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RpcResponse } from '../../../shared/remote-runtime/rpc/rpc-response-shape'
import {
  endSharedBotHostConnections,
  sharedBotHostLink,
  type SharedBotHostLink
} from './shared-bot-host-link'
import {
  newSharedBotHostEntry,
  SharedBotHostStore,
  type SharedBotHostEntry
} from './shared-bot-host-store'
import { applySharedBotMine, sharedBotRequests, usableHere } from './shared-bot-mine-apply'
import { SharedBotHeldSends } from './shared-bot-held-sends'
import { sharedBotUnshared } from './shared-bot-host-answers'
import { callHoldingHost } from './shared-bot-held-call'
import { nextPairingStep, type MineShare } from './shared-bot-pairing'
import { SerialRerun } from '../../../shared/concurrency/serial-rerun'
import { CloudSharesSupport, type SharedBotsCloud } from './shared-bots-cloud'
import { SharedBotOfferWaits } from './shared-bot-offer-waits'
import { SharedBotPhoneGrants } from './shared-bot-phone-grants'
import { SharedBotReadPace, type SharedBotReadPaceDeps } from './shared-bot-read-pace'
import { hasRelayCredential } from './shared-bot-host-key'

// How long a call on a dropped link waits for the share list to say whether it was a revoke.
const SHARES_LIST_WAIT_MS = 5000

export type SharedBotHostsDeps = Partial<Pick<SharedBotReadPaceDeps, 'invites' | 'random'>> & {
  userDataPath: string
  cloud: () => SharedBotsCloud | null
  /** The signed-in Orca account the cloud is read as; null signed out. */
  account: () => string | null
  /** Orca Cloud's connector origin, for this computer's phones; null without a cloud. */
  connectorOrigin?: () => string | null
  publish: (state: SharedBotHostsState) => void
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
  private readonly pace: SharedBotReadPace
  private readonly offerWaits = new SharedBotOfferWaits()
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
      account: () => deps.account(),
      origin: () => deps.connectorOrigin?.() ?? null,
      requests: () => sharedBotRequests(this.store, this.shares),
      answer: (shareId, accept) => (accept ? this.accept(shareId) : this.decline(shareId))
    })
    this.pace = new SharedBotReadPace({
      ...deps,
      now: this.now,
      read: () => void this.refresh(),
      nextReadMs: (woken) => this.offerWaits.nextReadMs(this.store.list(), this.readState, woken)
    })
  }

  // What sets the read pace for one entry: pairing, away or holding a message reads sooner.
  private readonly readState = (entry: SharedBotHostEntry) => ({
    link: this.linkFor(entry).current(),
    waiting: entry.held.some((held) => this.held.isWaiting(held))
  })

  /** The kept shares are loaded, so `views` lists them. */
  ready(): Promise<void> {
    return (this.loaded ??= this.store.load())
  }

  /** Follows the cloud's list once `before` (work on the kept shares) settles, unless stopped by then. */
  start(before: Promise<unknown> = Promise.resolve()): void {
    this.stopped = false
    void before
      .catch(() => {})
      .then(() => {
        if (!this.stopped) {
          this.pace.start()
          void this.refresh()
        }
      })
  }

  /** Nothing reads or applies the cloud's list after this, a read already out included: quitting
   *  must never change the kept shares. */
  stop(): void {
    this.stopped = true
    this.pace.stop()
    for (const link of this.links.values()) {
      link.close()
    }
    this.links.clear()
    // As an ended share's: its host's connections go even where no link was made here.
    for (const entry of this.store.list()) {
      endSharedBotHostConnections(entry.environmentId)
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
        link: this.linkFor(entry).current(),
        accepting: this.offerWaits.connecting(entry.shareId, this.linkFor(entry).current()),
        holds: entry.hostKey !== undefined,
        held: this.held.views(entry)
      })
    )
  }

  /** The kept shares, but for those the cloud's last answer no longer lists. */
  listed(): SharedBotHostEntry[] {
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
    this.pace.began()
    const read = this.held.beginRead()
    const wait = this.offerWaits.take()
    const answer = this.stopped
      ? null
      : await this.sharing.read(this.deps.cloud(), () => this.publish(), wait)
    if (this.stopped) {
      applied()
      return
    }
    // Signed out: the account's shares, keys and links go with it. Any other failure keeps them.
    const shares = this.sharing.sharesIn(answer)
    if (shares) {
      this.applyMine(shares, read)
    }
    applied()
    if (shares) {
      await Promise.all(this.store.list().map((entry) => this.advance(entry)))
    }
    this.offerWaits.settled(wait)
    this.publish()
    this.pace.settled(answer?.ok === true)
  }

  /**
   * A call its share answers here, before the paired path sends it: a share the owner ended, or, while
   * held sends are on, a message held for a host that is away. Null sends it as any paired call.
   */
  async answerHere(
    environmentId: string,
    method: string,
    params: unknown,
    send: (method: string, params: unknown) => Promise<RpcResponse>
  ): Promise<RuntimeRpcResponse<unknown> | null> {
    const ended = await this.endedAnswer(environmentId, method)
    if (ended || !this.entryFor(environmentId)) {
      return ended
    }
    return SHARED_HOSTS_HOLD_WHILE_AWAY
      ? this.callHolding(environmentId, method, params, send)
      : null
  }

  /** A call to a share the owner ended: never an unknown host, and never sent. */
  async endedAnswer(
    environmentId: string,
    method: string
  ): Promise<RuntimeRpcResponse<unknown> | null> {
    await this.ready()
    return !this.entryFor(environmentId) && this.store.wasRemoved(environmentId)
      ? sharedBotUnshared(method)
      : null
  }

  private async callHolding(
    environmentId: string,
    method: string,
    params: unknown,
    send: (method: string, params: unknown) => Promise<RpcResponse>
  ): Promise<RuntimeRpcResponse<unknown>> {
    const reached = await this.reachShared(environmentId)
    if (!reached) {
      return sharedBotUnshared(method)
    }
    return callHoldingHost(this.held, reached.entry, reached.link, method, params, send)
  }

  /** Sends a held message the host refused again; false when it isn't one, or wasn't held. */
  async sendAgain(environmentId: string, clientMessageId: string): Promise<boolean> {
    await this.ready()
    const entry = this.entryFor(environmentId)
    return entry ? this.held.sendAgain(entry, clientMessageId) : false
  }

  /** Applies the cloud's list: the kept shares it no longer lists are removed. */
  private applyMine(shares: readonly MineShare[], read: number): void {
    this.shares = new Map(shares.map((share) => [share.shareId, share]))
    // Its host's connections go even where no link was made here (the window's calls open them too).
    const closeLink = (shareId: string) => {
      this.links.get(shareId)?.close()
      this.links.delete(shareId)
      const environmentId = this.store.get(shareId)?.environmentId
      if (environmentId) {
        endSharedBotHostConnections(environmentId)
      }
    }
    applySharedBotMine({ store: this.store, held: this.held, closeLink }, shares, read)
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
        this.offerWaits.accepted(entry)
      }
    } else if (step.kind === 'connect' && (step.credential.kind === 'invite' || share.hostOnline)) {
      const link = await this.linkFor(entry).connect()
      this.deps.failures?.linked(entry.shareId, link, share.hostOnline)
      await this.phones.endRemoved(entry.shareId)
    }
  }

  /** The link once any dial this entry can make has settled. */
  private async reach(entry: SharedBotHostEntry) {
    const link = this.linkFor(entry)
    const share = this.shares?.get(entry.shareId)
    const step = share ? nextPairingStep(entry, share, this.now()) : null
    return step?.kind === 'connect' ? link.connect() : link.settled()
  }

  /** Once a cloud read under way or asked for has its list applied (not its pairings), capped. */
  async settled(): Promise<void> {
    await this.reads.nextListed()
  }

  private entryFor(environmentId: string): SharedBotHostEntry | undefined {
    return this.store.list().find((entry) => entry.environmentId === environmentId)
  }

  private linkFor(entry: SharedBotHostEntry): SharedBotHostLink {
    let link = this.links.get(entry.shareId)
    if (!link) {
      link = sharedBotHostLink({
        environmentId: entry.environmentId,
        hasCredential: () => hasRelayCredential(this.store.get(entry.shareId), this.now()),
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
