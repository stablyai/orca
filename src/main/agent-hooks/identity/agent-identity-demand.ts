import type { OrcaSessionId } from '../../../shared/orca-session-address'
import type { AgentProviderKey } from './agent-provider-key'
import type { AgentIdentityClient } from './agent-identity-worker-client'
import type { RowAgentIdentity } from './pane-agent-identities'

/** One exact provider key some current row or caller needs: the identity they all carry, the
 *  places to re-stamp, and explicit callers waiting for its answer. Dropped once nothing current
 *  needs it; the database stays the history. */
export type KeyDemand = {
  key: AgentProviderKey
  identity: RowAgentIdentity
  places: Set<string>
  waiters: Set<(id: OrcaSessionId | null) => void>
}

type Operation = { kind: 'identify'; keyString: string } | { kind: 'has'; id: string }

const RETRY_DELAY_MS = 30_000
/** An explicit caller (Copy, refusal) waits at most this long; its row demand outlives it. */
const CALLER_WAIT_MS = 10_000

/** The hook server's identity work: one worker operation at a time, only for keys something
 *  current still needs. One failure stops every operation for 30 s, except one per Copy click;
 *  a single wake then retries while rows still wait. A replaced worker must exit before
 *  another starts. */
export class AgentIdentityDemand {
  private client: AgentIdentityClient | null = null
  /** The store this generation answers for; a different path is a different authority. */
  private authorityPath: string | null = null
  private generationValue = 0
  private retiring: Promise<void> | null = null
  private active: Operation | null = null
  private pumpScheduled = false
  private retryAt = 0
  private failing = false
  private wake: NodeJS.Timeout | null = null
  private readonly keys = new Map<string, KeyDemand>()
  /** Keys still unanswered, in demand order; a key leaves when it settles or nothing needs it. */
  private readonly unresolved = new Set<string>()
  /** Keys a Copy click may send once despite the failure backoff. */
  private readonly bypass = new Set<string>()
  private readonly memberships = new Map<string, Set<(known: boolean | undefined) => void>>()

  constructor(
    private readonly databasePath: () => string | null,
    private readonly onAnswer: (demand: KeyDemand, identity: RowAgentIdentity) => void,
    private readonly createClient: () => AgentIdentityClient,
    /** Runs as an authority ends, so rows carrying its answers ask the next one. */
    private readonly onAuthorityEnded: () => void = () => {}
  ) {}

  /** Bumped when the store authority ends; an answer from an older one stamps nothing. */
  get generation(): number {
    return this.generationValue
  }

  /** Synchronizes with the current store first, so first use is not mistaken for a replacement;
   *  a caller compares the returned token after its own awaits. */
  authority(): number {
    this.syncAuthority()
    return this.generationValue
  }

  of(keyString: string): KeyDemand | undefined {
    return this.keys.get(keyString)
  }

  subscribe(keyString: string, identity: RowAgentIdentity, place: string): void {
    const demand = this.keys.get(keyString) ?? this.demandFor(keyString, identity)
    demand.places.add(place)
    if (demand.identity.pending) {
      this.unresolved.add(keyString)
      this.schedulePump()
    }
  }

  unsubscribe(keyString: string, place: string): void {
    this.keys.get(keyString)?.places.delete(place)
    this.release(keyString)
  }

  async identify(keyString: string, key: AgentProviderKey): Promise<OrcaSessionId | null> {
    this.syncAuthority()
    const generation = this.generationValue
    const demand =
      this.keys.get(keyString) ?? this.demandFor(keyString, { key, id: null, pending: true })
    if (!demand.identity.pending) {
      return demand.identity.id
    }
    const id = await new Promise<OrcaSessionId | null>((resolve) => {
      const waiter = (answer: OrcaSessionId | null): void => {
        clearTimeout(timer)
        demand.waiters.delete(waiter)
        // The grant belongs to live clicks: with none left, a row waits for the automatic retry.
        if (demand.waiters.size === 0) {
          this.bypass.delete(keyString)
        }
        this.release(keyString)
        resolve(answer)
      }
      const timer = setTimeout(() => waiter(null), CALLER_WAIT_MS)
      timer.unref()
      demand.waiters.add(waiter)
      this.unresolved.add(keyString)
      // A click joining the operation already running for this key earns no second attempt.
      if (!(this.active?.kind === 'identify' && this.active.keyString === keyString)) {
        this.bypass.add(keyString)
      }
      this.schedulePump()
    })
    // An answer accepted before the owner closed is not this generation's to give.
    return generation === this.generationValue ? id : null
  }

  /** Membership shares the failure gate: during the backoff it answers unavailable at once. */
  async has(id: string): Promise<boolean | undefined> {
    this.syncAuthority()
    if (!this.authorityPath || Date.now() < this.retryAt) {
      return undefined
    }
    const generation = this.generationValue
    const known = await new Promise<boolean | undefined>((resolve) => {
      const waiters = this.memberships.get(id) ?? new Set()
      const waiter = (answer: boolean | undefined): void => {
        clearTimeout(timer)
        waiters.delete(waiter)
        if (waiters.size === 0 && this.memberships.get(id) === waiters) {
          this.memberships.delete(id)
        }
        resolve(answer)
      }
      const timer = setTimeout(() => waiter(undefined), CALLER_WAIT_MS)
      timer.unref()
      waiters.add(waiter)
      this.memberships.set(id, waiters)
      this.schedulePump()
    })
    return generation === this.generationValue ? known : undefined
  }

  /** A different store path is a different authority: nothing carries across. */
  syncAuthority(): void {
    const path = this.databasePath()
    if (path !== this.authorityPath) {
      this.close()
      this.authorityPath = path
      // Rows still pending from the ended authority ask this one.
      this.schedulePump()
    }
  }

  /** Ends this store authority: callers get no answer, nothing is sent, and settled answers are
   *  forgotten; a row still pending asks the next authority. */
  close(): void {
    this.generationValue++
    const client = this.client
    this.client = null
    if (client) {
      client.dispose()
      this.awaitRetirement(client)
    }
    this.active = null
    this.retryAt = 0
    this.failing = false
    this.clearWake()
    this.bypass.clear()
    for (const waiters of this.memberships.values()) {
      for (const waiter of waiters) {
        waiter(undefined)
      }
    }
    this.memberships.clear()
    for (const [keyString, demand] of this.keys) {
      for (const waiter of demand.waiters) {
        waiter(null)
      }
      if (!demand.identity.pending) {
        this.keys.delete(keyString)
      }
    }
    this.onAuthorityEnded()
  }

  /** One continuation per retiring worker: the pump resumes when it has exited. */
  private awaitRetirement(client: AgentIdentityClient): void {
    const retiring: Promise<void> = client
      .retired()
      .catch(() => {})
      .then(() => {
        if (this.retiring === retiring) {
          this.retiring = null
          this.schedulePump()
        }
      })
    this.retiring = retiring
  }

  private demandFor(keyString: string, identity: RowAgentIdentity): KeyDemand {
    const demand: KeyDemand = { key: identity.key, identity, places: new Set(), waiters: new Set() }
    this.keys.set(keyString, demand)
    return demand
  }

  /** Forgets a key nothing current needs; an operation already sent for it may finish, but stamps
   *  nothing. */
  private release(keyString: string): void {
    const demand = this.keys.get(keyString)
    if (demand && demand.places.size === 0 && demand.waiters.size === 0) {
      this.keys.delete(keyString)
      this.unresolved.delete(keyString)
      this.bypass.delete(keyString)
      if (this.unresolved.size === 0) {
        this.clearWake()
      }
    }
  }

  private schedulePump(): void {
    if (this.pumpScheduled) {
      return
    }
    this.pumpScheduled = true
    // After the admission that asked for it has finished storing and indexing its row.
    queueMicrotask(() => {
      this.pumpScheduled = false
      this.pump()
    })
  }

  private nextOperation(): Operation | null {
    if (Date.now() < this.retryAt) {
      const explicit = this.bypass.values().next().value
      if (explicit === undefined) {
        this.armWake()
        return null
      }
      return { kind: 'identify', keyString: explicit }
    }
    const membership = this.memberships.keys().next().value
    if (membership !== undefined) {
      return { kind: 'has', id: membership }
    }
    const keyString = this.unresolved.values().next().value
    return keyString === undefined ? null : { kind: 'identify', keyString }
  }

  /** Sends the next operation something current still needs, one at a time. */
  private pump(): void {
    this.syncAuthority()
    const path = this.authorityPath
    if (this.active || this.retiring || !path) {
      return
    }
    if (this.client?.isRetiring) {
      // A failed worker is still exiting; nothing starts beside it.
      this.awaitRetirement(this.client)
      return
    }
    const operation = this.nextOperation()
    if (!operation) {
      return
    }
    const client = (this.client ??= this.createClient())
    this.active = operation
    const generation = this.generationValue
    const current = (): boolean => generation === this.generationValue
    if (operation.kind === 'has') {
      void client.has(path, operation.id).then((known) => {
        if (current()) {
          for (const waiter of this.memberships.get(operation.id) ?? []) {
            waiter(known)
          }
        }
        this.finish(operation, generation, known === undefined)
      })
      return
    }
    const { keyString } = operation
    // Sent now, so a click's grant on it is spent.
    this.bypass.delete(keyString)
    const key = this.keys.get(keyString)?.key
    if (!key) {
      this.unresolved.delete(keyString)
      this.finish(operation, generation, false)
      return
    }
    void client.identify(path, key).then((answer) => {
      if (current() && answer) {
        this.settle(keyString, { key, id: answer.id, authority: generation })
      } else if (current()) {
        for (const waiter of this.keys.get(keyString)?.waiters ?? []) {
          waiter(null)
        }
      }
      this.finish(operation, generation, answer === undefined)
    })
  }

  private finish(operation: Operation, generation: number, failed: boolean): void {
    if (generation !== this.generationValue || this.active !== operation) {
      return
    }
    this.active = null
    if (failed) {
      this.retryAt = Date.now() + RETRY_DELAY_MS
      if (!this.failing) {
        console.warn('[agent-hooks] agent identities unavailable; retrying after a delay')
      }
      this.failing = true
      this.armWake()
      // Background work waits for the wake, but a click queued behind this one still gets its try.
      this.schedulePump()
      return
    }
    this.failing = false
    this.retryAt = 0
    this.clearWake()
    this.schedulePump()
  }

  /** One owner-wide retry at the failure boundary, only while current rows still wait. */
  private armWake(): void {
    if (this.wake || this.unresolved.size === 0) {
      return
    }
    this.wake = setTimeout(
      () => {
        this.wake = null
        this.schedulePump()
      },
      Math.max(0, this.retryAt - Date.now())
    )
    this.wake.unref()
  }

  private clearWake(): void {
    if (this.wake) {
      clearTimeout(this.wake)
      this.wake = null
    }
  }

  private settle(keyString: string, identity: RowAgentIdentity): void {
    this.unresolved.delete(keyString)
    this.bypass.delete(keyString)
    const demand = this.keys.get(keyString)
    if (!demand) {
      return
    }
    demand.identity = identity
    for (const waiter of demand.waiters) {
      waiter(identity.id)
    }
    this.onAnswer(demand, identity)
  }
}
