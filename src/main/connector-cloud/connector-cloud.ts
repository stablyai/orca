// This host's link to the Orca Cloud connector, as whichever Orca account it is signed in to.
import { connectorAccountName } from './connector-token-mint'
import type { z } from 'zod'
import type { ConnectorCloudStatus } from '../../shared/bots/connector-cloud-status'
import {
  connectorStopNeedsSignIn,
  SIGNED_OUT,
  type ConnectorResult
} from './connector-cloud-request'
import { ConnectorPollClient } from './connector-poll-client'
import type { ConnectorMachine } from './connector-machine'
import {
  ConnectorAccountTransport,
  type ConnectorCallOptions,
  type ConnectorTokenMint
} from './connector-transport'
import { ConnectorTurnEvents } from './connector-turn-events'
import { ConnectorReach } from './connector-reach'
import type { ConnectorReplyJournal } from './connector-reply-outbox'
import { connectorRefResolver, type ConnectorRefResolver } from './connector-ref-resolution'
import { postConnectorOutboxReply } from './connector-replies'
import type { ConnectorCloudFeature } from '../../shared/connectors/connector-cloud-contract'

// Past this, a held call goes ahead without the hello and gets the cloud's own refusal.
const HOLD_HELLO_WAIT_MS = 10_000

export type ConnectorCloudOptions = {
  userDataPath: string
  origin: string
  machine: ConnectorMachine
  /** The signed-in Orca account, or null while signed out. */
  account: () => string | null
  /** Quitting or relaunching into another profile: nothing new starts, as for the relay. */
  isFenced: () => boolean
  /** Mints connector tokens for one account and no other. */
  mintFor: (account: string) => ConnectorTokenMint
  /** `status()` may have changed. */
  onStatusChanged?: () => void
  /** The signed-in account is another one, or none: setups in flight belong to the old one. */
  onAccountSwitched?: () => void
  fetchImpl?: typeof globalThis.fetch
  /** The journal's reply outbox (design item 125); null while no journal is open. */
  replyJournal?: () => ConnectorReplyJournal | null
}

export class ConnectorCloud {
  private connected = false
  private client: ConnectorPollClient | null = null
  // The client waiting to flush before it stops, since this machine stopped needing the connection.
  private settling: ConnectorPollClient | null = null
  // Calls that need the cloud to know this machine's bots before any has a connector.
  private holds = 0
  // The signed-in account's outbox: one owner per process, replaced only when another account signs in.
  private events: ConnectorTurnEvents | null = null
  // While a sign-out runs: the account it removes is still readable, and a refresh may even renew it.
  private signingOut = false
  // Why the cloud stopped the running client; null while it runs or none does.
  private clientStop: string | null = null
  private readonly reach = new ConnectorReach(() => this.options.onStatusChanged?.())
  // One token cache per account, shared by the poll and the bot calls.
  private transport: {
    account: string
    transport: ConnectorAccountTransport
  } | null = null

  // The account the last sign-in hook saw, so a refresh of the same one is not a switch.
  private lastAccount: string | null

  constructor(private readonly options: ConnectorCloudOptions) {
    this.lastAccount = options.account()
  }

  /** The signed-in Orca account the connector acts as, or null. */
  signedInAccount(includeFenced = false): string | null {
    return includeFenced ? this.options.account() : this.activeAccount()
  }

  private noteAccount(): void {
    const account = this.signingOut ? null : this.options.account()
    if (account !== this.lastAccount) {
      this.lastAccount = account
      this.options.onAccountSwitched?.()
    }
  }

  /** From now on, hold the poll whenever an Orca account is signed in and the machine wants the connection. */
  connect(): void {
    if (this.connected) {
      return
    }
    this.connected = true
    this.options.machine.onHelloInputsChanged(() => {
      // A running client says the change first, so a last connector's removal reaches the cloud before it stops.
      this.client?.sayChanged()
      this.reconcile()
    })
    this.reconcile()
  }

  /**
   * Holds the connection while `run` needs the cloud to know this machine's bots, e.g. to set up a
   * bot's first Slack app: the cloud learns bots only from a hello.
   */
  async withConnection<T>(run: () => Promise<T>): Promise<T> {
    this.holds++
    try {
      this.reconcile()
      const { client } = this
      if (client) {
        const waited = new AbortController()
        const timer = setTimeout(() => waited.abort(), HOLD_HELLO_WAIT_MS)
        await client.helloTaken(waited.signal)
        clearTimeout(timer)
      }
      return await run()
    } finally {
      this.holds--
      this.reconcile()
    }
  }

  /** The desktop signed in, switched accounts or refreshed its sign-in. */
  accountChanged(): void {
    // A new sign-in may lift a stop the cloud made; a fresh client asks again.
    if (this.clientStop) {
      this.stopClient()
    }
    this.noteAccount()
    this.reconcile()
    this.options.onStatusChanged?.()
  }

  /** Whether the cloud stopped the connection until this computer signs in to Orca again. */
  needsSignIn(): boolean {
    return connectorStopNeedsSignIn(this.clientStop)
  }

  /** What `bots.list` says of this connection. */
  botListFacts(): {
    threadReplies: boolean
    githubEvents2: boolean
    githubWorkflows: boolean
    connectorStatus: ConnectorCloudStatus
    connectorMessage?: string
    connectorNeedsSignIn?: true
  } {
    const connectorStatus = this.status()
    return {
      threadReplies: this.takesThreadReplies(),
      // Whether it sends GitHub's newer events and label=, so trigger-options offers only those it does.
      githubEvents2:
        this.cloudFeatures()?.has('triggers.github2' satisfies ConnectorCloudFeature) === true,
      // Whether it sends github.workflow_finished, so trigger-options offers it only where it does.
      githubWorkflows:
        this.cloudFeatures()?.has('triggers.workflows' satisfies ConnectorCloudFeature) === true,
      connectorStatus,
      ...((connectorStatus === 'refused' || connectorStatus === 'needs-sign-in') &&
      this.reach.refusal
        ? { connectorMessage: this.reach.refusal }
        : {}),
      ...(this.needsSignIn() || connectorStatus === 'needs-sign-in'
        ? { connectorNeedsSignIn: true }
        : {})
    }
  }

  /**
   * Signed out (or refused until it signs in again), a running poll that can't reach Orca Cloud, one
   * the cloud refuses with a reason for the owner, or fine.
   */
  status(): ConnectorCloudStatus {
    if (!this.activeAccount() || this.needsSignIn()) {
      return 'signed-out'
    }
    if (!this.client) {
      return 'ok'
    }
    if (this.reach.unauthorized) {
      return 'needs-sign-in'
    }
    return this.reach.unreachable ? 'unreachable' : this.reach.refusal ? 'refused' : 'ok'
  }

  /** Just before the desktop signs out: stop now, and drop turn ends no other account can report. */
  signOutStarted(): void {
    this.signingOut = true
    this.noteAccount()
    this.stopClient()
    if (this.events) {
      this.events.clear()
      this.events = null
    } else {
      ConnectorTurnEvents.clearStored(this.options.userDataPath)
    }
    // What linked conversations' cards showed was this account's; a later sign-in starts afresh.
    this.options.machine.resetConversations?.()
    this.options.onStatusChanged?.()
  }

  /** Quit or relaunch: stop now; pending turn ends stay on disk for the next launch of this account. */
  fence(): void {
    this.reconcile()
  }

  /** The sign-out ended, either way; a sign-in that finished meanwhile resumes here. */
  signOutFinished(): void {
    this.signingOut = false
    this.reconcile()
    this.options.onStatusChanged?.()
  }

  /** An authorized call as the signed-in account, polling or not; refused while signing out or quitting. */
  async call<TSchema extends z.ZodType>(
    path: string,
    body: unknown,
    schema: TSchema,
    options?: ConnectorCallOptions
  ): Promise<ConnectorResult<z.infer<TSchema>>> {
    const account = this.activeAccount()
    return account ? await this.transportFor(account).call(path, body, schema, options) : SIGNED_OUT
  }

  private activeAccount(): string | null {
    return this.signingOut || this.options.isFenced() ? null : this.options.account()
  }

  private transportFor(account: string): ConnectorAccountTransport {
    if (this.transport?.account !== account) {
      this.transport = {
        account,
        transport: new ConnectorAccountTransport(
          this.options.origin,
          this.options.mintFor(account),
          this.options.fetchImpl
        )
      }
    }
    return this.transport.transport
  }

  private reconcile(): void {
    if (!this.connected) {
      return
    }
    const account = this.activeAccount()
    const seam = this.options.machine.seam()
    if (account && this.events?.account !== account) {
      this.stopClient()
      // Pending turn ends belong to the previous account's threads; no other account may report them.
      this.events?.clear()
      this.events = new ConnectorTurnEvents(this.options.userDataPath, account, undefined, {
        journal: () => this.options.replyJournal?.() ?? null,
        onOwed: () => this.reconcile(),
        // This account's own transport, fenced at the wire: never another account's.
        post: async (body) =>
          this.activeAccount() === account
            ? await postConnectorOutboxReply(this.transportFor(account), body)
            : SIGNED_OUT,
        hostName: () => this.options.machine.hostName()
      })
      this.options.machine.resetConversations?.()
      // Rows a quit left filled and unsent: counting them is reason enough to connect.
      void this.events.drainReplies()
    }
    if (this.client && (this.client.seam !== seam || !account)) {
      this.stopClient()
    }
    const wanted = this.holds > 0 || this.options.machine.wantsConnection()
    const { events } = this
    // Turn ends left on disk by an earlier run still go up, even with no connector left; it then settles.
    if (!this.client && (wanted || (events?.owed ?? 0) > 0) && seam && account && events) {
      const client = new ConnectorPollClient({
        transport: this.reach.tracked(this.transportFor(account)),
        events,
        seam,
        machine: this.options.machine,
        onHalt: (reason) => {
          if (this.client === client) {
            this.clientStop = reason
            if (this.needsSignIn()) {
              this.options.onStatusChanged?.()
            }
          }
        }
      })
      this.client = client
      client.start()
    }
    if (this.client && !wanted) {
      this.settleThenStop(this.client)
    } else {
      this.settling = null
    }
  }

  /** Acks, events, posts and the hello saying what changed all reach the cloud before the client stops. */
  private settleThenStop(client: ConnectorPollClient): void {
    if (this.settling === client) {
      return
    }
    this.settling = client
    void client.settled().then(() => {
      // Wanted again meanwhile, or already replaced.
      if (this.settling === client && this.client === client) {
        this.stopClient()
      }
    })
  }

  /** What the cloud's last hello answer listed; null until one arrives or while no client runs. */
  cloudFeatures(): ReadonlySet<string> | null {
    return this.client?.cloudFeatures ?? null
  }

  /** The signed-in Orca account's name, as a mirrored Slack post names its author. */
  orcaAccountName(): string {
    return connectorAccountName(this.options.userDataPath)
  }

  /** Whether a rule's run can answer in its event's thread; an older cloud would bind none and drop the post. */
  takesThreadReplies(): boolean {
    return this.cloudFeatures()?.has('triggers.inThread' satisfies ConnectorCloudFeature) === true
  }

  /** Rules and results name places by ref only once the cloud takes refs; null keeps the older names. */
  refResolver(): ConnectorRefResolver | null {
    const features = this.cloudFeatures()
    return features?.has('refs' satisfies ConnectorCloudFeature) &&
      features.has('actions' satisfies ConnectorCloudFeature)
      ? connectorRefResolver(
          this,
          new AbortController().signal,
          features.has('places' satisfies ConnectorCloudFeature)
        )
      : null
  }

  /** Rows were filled: send them with whatever client runs, or connect for them. */
  repliesFilled(): void {
    void this.events?.drainReplies()
  }

  /** Null while no client runs: signed out, no bot the cloud can reach, or Orca quitting. */
  reply(
    body: Parameters<ConnectorPollClient['reply']>[0]
  ): ReturnType<ConnectorPollClient['reply']> | null {
    return this.client?.reply(body) ?? null
  }

  /** Null while no client runs: signed out, no bot the cloud can reach, or Orca quitting. */
  postAsBot(
    ...args: Parameters<ConnectorPollClient['postAsBot']>
  ): ReturnType<ConnectorPollClient['postAsBot']> | null {
    return this.client?.postAsBot(...args) ?? null
  }

  private stopClient(): void {
    const neededSignIn = this.needsSignIn()
    this.client?.stop()
    this.client = null
    this.clientStop = null
    this.settling = null
    if (neededSignIn) {
      this.options.onStatusChanged?.()
    }
    this.reach.reached({ ok: true, value: undefined })
  }
}
