// The wake channel a hello answer offers: a socket that says when to poll, so polls need not be held.
// Without an open socket (past a short grace) the client long-polls exactly as without an offer.
import {
  CONNECTOR_WAKE_KEEPALIVE_INTERVAL_MS,
  CONNECTOR_WAKE_MAX_HOLD_MS,
  type ConnectorWakeOffer
} from '../../../cloud/packages/connector-contract/src/wake-messages'
import type { ConnectorPollClientOptions } from './connector-machine'
import type { ConnectorWakeTokenResult } from './connector-transport'
import {
  openConnectorWakeSocket,
  type ConnectorWakeSocketEnd,
  type ConnectorWakeSocketFactory
} from './connector-wake-socket'

// A dropped socket gets this long to come back before the client long-polls again.
const DOWN_GRACE_MS = 10_000
// Failed connects in a row after which the client long-polls while it keeps redialing.
const MAX_FAILED_CONNECTS = 3
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 60_000
const MAX_RETRY_AFTER_MS = 5 * 60_000
// A wake's poll holds briefly; every other poll here (safety, follow-up, catch-up) returns at once.
const WAKE_POLL_HOLD_MS = Math.min(2_000, CONNECTOR_WAKE_MAX_HOLD_MS)

export type ConnectorWakePoll = { holdMs: number }

export type ConnectorWakeChannelDeps = {
  /** The wake token, renewed first when `renew` (a 401) or when it has under a minute left. */
  token: (renew: boolean) => Promise<ConnectorWakeTokenResult>
  random: () => number
  socketFactory?: ConnectorWakeSocketFactory
}

export class ConnectorWakeChannel {
  private offered: ConnectorWakeOffer | null = null
  // Refused until the next hello (country refused, replaced, frame too big, no wake token).
  private refused = false
  private stopped = false
  private socket: { close(): void } | null = null
  private dialing = false
  private open = false
  private openedAt = 0
  private downSince: number | null = null
  private closedAt: number | null = null
  private failures = 0
  private attempt = 0
  private redial: ReturnType<typeof setTimeout> | null = null
  // The next poll owed, by why: a wake holds briefly, anything else not at all.
  private owed: 'wake' | 'other' | null = null
  private safetyDueAt = 0
  private changed: (() => void) | null = null

  constructor(private readonly deps: ConnectorWakeChannelDeps) {}

  /** Each hello answer: its offer, or null when it offers none. */
  offer(offer: ConnectorWakeOffer | null): void {
    if (this.stopped) {
      return
    }
    if (!offer || offer.wakeUrl !== this.offered?.wakeUrl) {
      this.drop()
    }
    this.offered = offer
    this.refused = false
    this.failures = 0
    if (offer) {
      this.safetyDueAt ||= this.safetyDue()
      this.dial(false)
    }
    this.notify()
  }

  /** Work the cloud may now hand out without a wake (an accepted ack); coalesced with others. */
  requestPoll(): void {
    this.owed ??= 'other'
    this.notify()
  }

  /** A poll went out: it covers whatever was owed, and the safety poll restarts from now. */
  polled(): void {
    this.owed = null
    this.safetyDueAt = this.safetyDue()
  }

  /** Whether the client polls without holding now: an open socket, or one still in its grace. */
  get active(): boolean {
    if (!this.offered || this.refused || this.stopped) {
      return false
    }
    if (this.open) {
      return true
    }
    return (
      this.downSince !== null &&
      Date.now() - this.downSince <= DOWN_GRACE_MS &&
      this.failures < MAX_FAILED_CONNECTS
    )
  }

  /** The next poll's hold, once one is owed; null once the client should long-poll instead, or
   *  once `stale` (its hello was replaced or dropped; `recheck` says so). */
  async nextPoll(signal: AbortSignal, stale: () => boolean): Promise<ConnectorWakePoll | null> {
    while (!signal.aborted && this.active && !stale()) {
      const now = Date.now()
      if (this.open && this.owed) {
        const holdMs = this.owed === 'wake' ? WAKE_POLL_HOLD_MS : 0
        this.owed = null
        return { holdMs }
      }
      if (this.open && now >= this.safetyDueAt) {
        return { holdMs: 0 }
      }
      const until = this.open ? this.safetyDueAt : (this.downSince ?? now) + DOWN_GRACE_MS + 1
      await this.waitForChange(Math.max(1, until - now), signal)
    }
    return null
  }

  /** Something `nextPoll`'s `stale` reads changed. */
  recheck(): void {
    this.notify()
  }

  stop(): void {
    this.stopped = true
    this.offered = null
    this.drop()
    this.notify()
  }

  private safetyDue(): number {
    const base = this.offered?.safetyPollMs ?? 0
    // ± a sixth: 3 min ± 30 s at the default.
    return Date.now() + base + ((this.deps.random() * 2 - 1) * base) / 6
  }

  private drop(): void {
    if (this.redial) {
      clearTimeout(this.redial)
      this.redial = null
    }
    if (this.open) {
      this.closedAt = Date.now()
    }
    this.socket?.close()
    this.socket = null
    this.open = false
    this.downSince = null
  }

  private dial(renewed: boolean): void {
    const offer = this.offered
    if (!offer || this.refused || this.stopped || this.socket || this.dialing || this.redial) {
      return
    }
    this.dialing = true
    void this.deps
      .token(renewed)
      .catch((): 'failed' => 'failed')
      .then((token) => {
        this.dialing = false
        if (this.refused || this.stopped || this.socket) {
          return
        }
        // A newer hello's offer came while this token was fetched: dial for that one instead.
        if (this.offered !== offer) {
          this.dial(renewed)
          return
        }
        // An auth service without wake tokens: long-poll until the next hello.
        if (token === 'none') {
          this.refused = true
          this.notify()
          return
        }
        // A mint that failed (network, auth 5xx) is a failed connect: back off and dial again.
        if (token === 'failed') {
          this.ended({ opened: false, action: 'backoff', retryAfterMs: null, code: null }, renewed)
          return
        }
        const gapMs = this.closedAt === null ? null : Date.now() - this.closedAt
        this.socket = this.connect(offer, token.token, gapMs, renewed)
      })
  }

  private connect(
    offer: ConnectorWakeOffer,
    token: string,
    gapMs: number | null,
    renewed: boolean
  ): { close(): void } | null {
    try {
      const socket = openConnectorWakeSocket(
        offer.wakeUrl,
        token,
        gapMs,
        {
          opened: () => this.opened(),
          wake: () => {
            this.owed = 'wake'
            this.notify()
          },
          ended: (end) => {
            if (this.socket === socket) {
              this.ended(end, renewed)
            }
          }
        },
        this.deps.socketFactory
      )
      return socket
    } catch (error) {
      // An address this build can't dial: long-poll until the next hello.
      console.warn('[connector] wake socket could not open', error)
      this.refused = true
      this.notify()
      return null
    }
  }

  private opened(): void {
    this.open = true
    this.openedAt = Date.now()
    this.downSince = null
    this.failures = 0
    // Wakes sent while it was down or connecting are lost: one poll catches up.
    this.owed ??= 'other'
    this.notify()
  }

  private ended(end: ConnectorWakeSocketEnd, renewed: boolean): void {
    const now = Date.now()
    this.socket = null
    if (this.open) {
      this.open = false
      this.closedAt = now
      this.downSince = now
    }
    if (end.action === 'until-hello') {
      this.refused = true
      this.notify()
      return
    }
    if (end.action === 'refresh-token' && !renewed) {
      this.dial(true)
      this.notify()
      return
    }
    if (!end.opened) {
      this.failures++
    }
    // Only a socket that lasted resets the backoff, so one that drops at once can't loop tightly.
    if (end.opened && now - this.openedAt >= CONNECTOR_WAKE_KEEPALIVE_INTERVAL_MS) {
      this.attempt = 0
    }
    const backoffMs =
      this.deps.random() * Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt)
    this.attempt++
    const delayMs =
      end.retryAfterMs === null ? backoffMs : Math.min(end.retryAfterMs, MAX_RETRY_AFTER_MS)
    this.redial = setTimeout(() => {
      this.redial = null
      this.dial(false)
    }, delayMs)
    this.redial.unref?.()
    this.notify()
  }

  private waitForChange(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        if (this.changed === done) {
          this.changed = null
        }
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal.addEventListener('abort', done, { once: true })
      this.changed = done
    })
  }

  private notify(): void {
    this.changed?.()
  }
}

/** A poll client's wake channel, made by the first hello answer offering one it can use. */
export class ConnectorWakePolls {
  private channel: ConnectorWakeChannel | null = null
  // The hello the last poll went out under: a new one's first poll goes at once.
  private polledRev: number | null = null

  constructor(
    private readonly options: Pick<ConnectorPollClientOptions, 'transport' | 'wakeSocketFactory'>,
    private readonly random: () => number,
    /** The client's stop, which ends the channel for good. */
    private readonly stopped: AbortSignal
  ) {
    stopped.addEventListener('abort', () => this.channel?.stop(), { once: true })
  }

  /** Each hello answer's offer; none drops the socket, and polls are held again. */
  offer(offer: ConnectorWakeOffer | null): void {
    const { transport } = this.options
    if (!offer || !transport.wakeToken || this.stopped.aborted) {
      this.channel?.offer(null)
      return
    }
    this.channel ??= new ConnectorWakeChannel({
      token: (renew) => transport.wakeToken?.(renew) ?? Promise.resolve('none'),
      random: this.random,
      socketFactory: this.options.wakeSocketFactory
    })
    this.channel.offer(offer)
  }

  requestPoll(): void {
    this.channel?.requestPoll()
  }

  /** The client dropped its hello: a poll waiting under it ends, so the next cycle says hello. */
  helloDropped(): void {
    this.channel?.recheck()
  }

  /**
   * The next poll's holdMs once it is due: undefined to hold as before (no open socket); null with
   * no hello, or when stopped or another hello replaced `helloRev` meanwhile (it polls next cycle).
   */
  async hold(
    helloRev: number | null,
    currentRev: () => number | null,
    signal: AbortSignal
  ): Promise<number | undefined | null> {
    const { channel } = this
    if (helloRev === null) {
      return null
    }
    let holdMs: number | undefined
    if (channel?.active) {
      const stale = (): boolean => currentRev() !== helloRev
      const turn =
        this.polledRev === helloRev ? await channel.nextPoll(signal, stale) : { holdMs: 0 }
      if (signal.aborted || currentRev() !== helloRev) {
        return null
      }
      holdMs = turn?.holdMs
    }
    this.polledRev = helloRev
    channel?.polled()
    return holdMs
  }
}
