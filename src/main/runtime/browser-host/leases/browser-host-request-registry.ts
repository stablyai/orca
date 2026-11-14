/** Servers ask a connected desktop to start hosting when a page needs one and no desktop holds a lease (#35066). */
import { randomUUID } from 'node:crypto'
import type {
  BrowserClientHostRequestEvent,
  BrowserClientHostRequestResultParams
} from '../../../../shared/browser/client-hosting/browser-client-host-request-protocol'

const REQUEST_TIMEOUT_MS = 30_000
const DESKTOP_TIMEOUT_MS = 15_000

type Volunteer = {
  pairedDeviceId: string
  emit: (event: BrowserClientHostRequestEvent) => void
}

type Answer = { hosting: string } | 'declined' | 'silent'

type PendingAnswer = {
  pairedDeviceId: string
  resolve: (answer: Answer) => void
}

export type RequestedBrowserHost = { browserHostClientId: string; pairedDeviceId: string }

/** The asked desktop never answered; it may be asleep or its window unresponsive. */
export class BrowserHostUnresponsiveError extends Error {
  constructor(readonly pairedDeviceId: string) {
    super('browser_host_unavailable')
  }
}

export class BrowserHostRequestRegistry {
  private readonly volunteers: Volunteer[] = []
  private readonly pending = new Map<string, PendingAnswer>()
  /** Desktops that let an ask time out; asking again before they answer anything would only wait again. */
  private readonly unanswered = new Set<string>()
  private inFlight: Promise<RequestedBrowserHost> | null = null

  constructor(
    private readonly options: { requestTimeoutMs?: number; desktopTimeoutMs?: number } = {}
  ) {}

  /** One desktop may register several subscriptions; any of them answers for it. */
  register(input: Volunteer): () => void {
    const volunteer = { ...input }
    this.volunteers.push(volunteer)
    // A new subscription means the desktop is running again; hand it any ask its old socket may have swallowed.
    this.unanswered.delete(volunteer.pairedDeviceId)
    for (const [requestId, answer] of this.pending) {
      if (answer.pairedDeviceId === volunteer.pairedDeviceId) {
        try {
          volunteer.emit({ type: 'browserHostRequested', requestId })
        } catch {
          // That socket is gone too; its cleanup unregisters it.
        }
      }
    }
    return () => {
      const index = this.volunteers.indexOf(volunteer)
      if (index === -1) {
        return
      }
      this.volunteers.splice(index, 1)
      if (this.volunteers.some((entry) => entry.pairedDeviceId === volunteer.pairedDeviceId)) {
        return
      }
      this.unanswered.delete(volunteer.pairedDeviceId)
      for (const answer of this.pending.values()) {
        if (answer.pairedDeviceId === volunteer.pairedDeviceId) {
          // It may still finish hosting over another socket, so do not ask a second desktop.
          answer.resolve('silent')
        }
      }
    }
  }

  hasVolunteer(): boolean {
    return this.volunteers.length > 0
  }

  /** Concurrent callers share one request so a single desktop takes the lease. */
  request(): Promise<RequestedBrowserHost> {
    this.inFlight ??= this.askDesktops().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  settle(
    caller: { pairedDeviceId: string },
    result: BrowserClientHostRequestResultParams
  ): boolean {
    // Even an answer that arrives after the deadline shows the desktop answers again.
    this.unanswered.delete(caller.pairedDeviceId)
    const answer = this.pending.get(result.requestId)
    if (!answer || answer.pairedDeviceId !== caller.pairedDeviceId) {
      return false
    }
    answer.resolve(
      result.browserHostClientId ? { hosting: result.browserHostClientId } : 'declined'
    )
    return true
  }

  // Only an explicit decline moves on: a silent desktop may still take its lease, and asking another would leave two.
  private async askDesktops(): Promise<RequestedBrowserHost> {
    const deadline = Date.now() + (this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)
    const asked = new Set<string>()
    for (;;) {
      const remainingMs = deadline - Date.now()
      // Newest first, like the desktop browser bridge: the desktop that connected last is usually the one in use.
      const pairedDeviceId = this.volunteers.findLast(
        (entry) => !asked.has(entry.pairedDeviceId)
      )?.pairedDeviceId
      if (!pairedDeviceId || remainingMs <= 0) {
        throw new Error('browser_host_unavailable')
      }
      if (this.unanswered.has(pairedDeviceId)) {
        throw new BrowserHostUnresponsiveError(pairedDeviceId)
      }
      asked.add(pairedDeviceId)
      const answer = await this.ask(
        pairedDeviceId,
        Math.min(remainingMs, this.options.desktopTimeoutMs ?? DESKTOP_TIMEOUT_MS)
      )
      if (answer === 'silent') {
        if (this.volunteers.some((entry) => entry.pairedDeviceId === pairedDeviceId)) {
          this.unanswered.add(pairedDeviceId)
        }
        throw new BrowserHostUnresponsiveError(pairedDeviceId)
      }
      if (answer !== 'declined') {
        return { browserHostClientId: answer.hosting, pairedDeviceId }
      }
    }
  }

  private ask(pairedDeviceId: string, timeoutMs: number): Promise<Answer> {
    const requestId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => answer('silent'), timeoutMs)
      const answer = (value: Answer): void => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        resolve(value)
      }
      this.pending.set(requestId, { pairedDeviceId, resolve: answer })
      let delivered = false
      for (const volunteer of this.volunteers) {
        if (volunteer.pairedDeviceId !== pairedDeviceId) {
          continue
        }
        try {
          volunteer.emit({ type: 'browserHostRequested', requestId })
          delivered = true
        } catch {
          // That subscription's socket is gone; its cleanup unregisters it.
        }
      }
      if (!delivered) {
        answer('declined')
      }
    })
  }
}

const registries = new WeakMap<object, BrowserHostRequestRegistry>()

export function getBrowserHostRequestRegistry(runtime: {
  getRuntimeId(): string
}): BrowserHostRequestRegistry {
  let registry = registries.get(runtime)
  if (!registry) {
    registry = new BrowserHostRequestRegistry()
    registries.set(runtime, registry)
  }
  return registry
}
