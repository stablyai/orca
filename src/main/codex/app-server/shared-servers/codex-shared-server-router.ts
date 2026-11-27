import type { CodexAppServerServerRequest } from '../codex-app-server-connection-types'
import {
  codexChildThreadIdsInItem,
  codexFrameThreadId,
  codexSharedFrameParams,
  codexSubagentParentThreadId,
  field,
  type CodexSharedServerFrame
} from './codex-shared-server-frames'
import type { CodexSharedServerLease } from './codex-shared-server-lease'
import { CodexSharedServerUnrouted } from './codex-shared-server-unrouted'
import type { CodexSharedServerRecovery } from './codex-shared-server-recovery'

const MAX_RETIRED_THREADS = 4_096
/** The only server requests Codex sends without a thread; both are per account, and a server
 *  never serves two accounts, so any chat on it may answer. */
const SERVER_WIDE_REQUESTS: ReadonlySet<string> = new Set([
  'account/chatgptAuthTokens/refresh',
  'attestation/generate'
])

/** Notifications Codex sends without a thread that are about the account or the server itself,
 *  so every chat would have had its own copy. Any other threadless notification may carry one
 *  chat's content in a shape the router can't read, so it reaches no chat. */
const SERVER_WIDE_NOTIFICATIONS: ReadonlySet<string> = new Set([
  'skills/changed',
  'mcpServer/oauthLogin/completed',
  'mcpServer/startupStatus/updated',
  'account/updated',
  'account/gatewayOAuth/changed',
  'account/rateLimits/updated',
  'account/login/completed',
  'app/list/updated',
  'remoteControl/status/changed',
  'externalAgentConfig/import/progress',
  'externalAgentConfig/import/completed',
  'modelProvider/authRecoveryStarted',
  'modelProvider/authRecoveryCompleted',
  'deprecationNotice',
  'configWarning',
  'warning',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted'
])

/** Which chat owns each thread on one server, and where each frame goes. */
export class CodexSharedServerRouter {
  private readonly owners = new Map<string, CodexSharedServerLease>()
  private readonly retired = new Set<string>()
  private readonly unrouted: CodexSharedServerUnrouted

  constructor(
    private readonly leases: () => Iterable<CodexSharedServerLease>,
    /** Answers a server request no chat can take, so Codex doesn't wait on it. */
    private readonly refuse: (frame: CodexSharedServerFrame) => void,
    /** Threads a reattached server holds for chats that haven't claimed them yet. */
    private readonly recovery?: CodexSharedServerRecovery,
    /** The daemon seq of the frame being read now, on a relayed server. */
    private readonly seq: () => number | null = () => null
  ) {
    this.unrouted = new CodexSharedServerUnrouted(
      refuse,
      () => [...leases()].some((lease) => lease.pendingOpens.size > 0),
      () => recovery?.discoveryPartial === true
    )
  }

  openSettled(): void {
    this.unrouted.openSettled()
  }

  isClaimed(threadId: string): boolean {
    return this.owners.has(threadId)
  }

  heldByOther(threadId: string, lease: CodexSharedServerLease): boolean {
    const owner = this.owners.get(threadId)
    return owner !== undefined && owner !== lease
  }

  /** `opened`: claimed by a thread open's reply, the only claim that can find its early frames
   *  dropped; a helper's lost frames don't cost its parent chat its running turn. */
  claim(threadId: string, lease: CodexSharedServerLease, opened = false, history = false): void {
    const previous = this.owners.get(threadId)
    if (previous && previous !== lease) {
      previous.threads.delete(threadId)
    }
    this.owners.set(threadId, lease)
    lease.threads.add(threadId)
    if (!history) {
      lease.liveThreads.add(threadId)
    }
    // A chat that let this thread go no longer stops its turns: they are the new owner's now.
    for (const other of this.leases()) {
      if (other !== lease) {
        other.abandonedThreads.delete(threadId)
      }
    }
    this.retired.delete(threadId)
    const recovered = this.recovery?.take(threadId)
    if (recovered) {
      this.claimRecovered(recovered, lease)
    }
    for (const frame of this.unrouted.take(threadId)) {
      lease.liveThreads.add(threadId)
      // A held frame can name helpers of its own; claim them (and replay theirs) before delivery.
      if (frame.kind === 'notification') {
        this.discover(frame.method, frame.params)
      }
      lease.deliver(frame)
    }
    // Its early frames were dropped to bound memory: the chat reopens it from Codex's history
    // rather than run on with events missing.
    const lost = this.unrouted.takeLost(threadId, lease.restored !== null)
    if (lost) {
      lease.liveThreads.add(threadId)
    }
    // A restored chat's helper too: what it lost was its kept run's, so it catches up from history.
    if (lost && (opened || lease.restored !== null)) {
      lease.recoveryCut = true
      lease.shed()
    }
  }

  /** A recovered chat's threads and their held frames, in order: the family moves whole. */
  private claimRecovered(
    recovered: NonNullable<ReturnType<CodexSharedServerRecovery['take']>>,
    lease: CodexSharedServerLease
  ): void {
    for (const [threadId] of recovered.threads) {
      this.owners.set(threadId, lease)
      lease.threads.add(threadId)
      lease.liveThreads.add(threadId)
      this.retired.delete(threadId)
    }
    lease.recoveryCut ||= recovered.cut
    for (const frame of recovered.frames) {
      if (frame.kind === 'notification') {
        this.discover(frame.method, frame.params)
      }
      lease.deliver(frame)
    }
  }

  /** An unresolved root's owner is now known: it moves to that owner (or its held family). */
  ownerFound(threadId: string, parent: string): void {
    const owner = this.owners.get(parent)
    if (owner?.routable) {
      this.claim(threadId, owner)
    } else {
      this.recovery?.join(threadId, parent)
    }
  }

  /** The first seq no chat has taken that this router holds (unclaimed, or held for a claim).
   *  Unanswered requests aren't held here: the daemon re-sends every one at each attach. */
  floor(): number | null {
    const floors = [this.unrouted.floor(), this.recovery?.floor() ?? null]
    const held = floors.filter((seq): seq is number => seq !== null)
    return held.length > 0 ? Math.min(...held) : null
  }

  /** Drops one thread this chat claimed but no longer wants (a resume its caller gave up on). */
  unclaim(threadId: string, lease: CodexSharedServerLease): void {
    if (this.owners.get(threadId) === lease) {
      this.owners.delete(threadId)
      lease.threads.delete(threadId)
    }
  }

  /** Drops the chat's threads from routing; their late frames are refused. */
  release(lease: CodexSharedServerLease): string[] {
    const threads = [...lease.threads]
    for (const threadId of threads) {
      if (this.owners.get(threadId) === lease) {
        this.owners.delete(threadId)
        this.retire(threadId)
      }
    }
    lease.threads.clear()
    return threads
  }

  /** A restored chat gave its threads back unopened: they stop routing to it, retiring nothing. */
  handBack(lease: CodexSharedServerLease): string[] {
    const threads = [...lease.threads]
    for (const threadId of threads) {
      if (this.owners.get(threadId) === lease) {
        this.owners.delete(threadId)
      }
    }
    lease.threads.clear()
    return threads
  }

  /** Frames held for these threads while no chat owned them. */
  takeUnrouted(threads: readonly string[]): CodexSharedServerFrame[] {
    return threads.flatMap((threadId) => this.unrouted.take(threadId))
  }

  retire(threadId: string): void {
    this.retired.add(threadId)
    if (this.retired.size > MAX_RETIRED_THREADS) {
      const oldest = this.retired.values().next()
      if (!oldest.done) {
        this.retired.delete(oldest.value)
      }
    }
  }

  onNotification(method: string, params: unknown): void {
    this.discover(method, params)
    this.route({ kind: 'notification', method, params, seq: this.seq() })
  }

  /** Helper threads this frame hands to its parent's chat. */
  private discover(method: string, params: unknown): void {
    this.claimAnnouncedChildren(method, params)
    if (method === 'thread/started') {
      const parent = codexSubagentParentThreadId(params)
      const threadId = codexFrameThreadId(params)
      const owner = parent ? this.owners.get(parent) : undefined
      if (threadId && owner?.routable && this.owners.get(threadId) !== owner) {
        this.claim(threadId, owner)
      } else if (threadId && parent && !owner) {
        // Under a held parent (an expected chat's, or an unresolved root) it joins that family.
        this.recovery?.join(threadId, parent)
      }
    }
  }

  onServerRequest(request: CodexAppServerServerRequest): void {
    this.route({ kind: 'request', request, seq: this.seq() })
  }

  clear(): void {
    this.unrouted.clear()
    this.owners.clear()
    this.recovery?.clear()
  }

  /** A parent's item naming a helper hands that helper to the parent's chat. */
  private claimAnnouncedChildren(method: string, params: unknown): void {
    if (!method.startsWith('item/')) {
      return
    }
    const parent = codexFrameThreadId(params)
    const owner = parent ? this.owners.get(parent) : undefined
    if (parent && !owner && this.recovery?.holds(parent)) {
      for (const child of codexChildThreadIdsInItem(field(params, 'item'))) {
        this.recovery.join(child, parent)
      }
      return
    }
    if (!owner?.routable) {
      return
    }
    for (const child of codexChildThreadIdsInItem(field(params, 'item'))) {
      if (this.owners.get(child) !== owner) {
        this.claim(child, owner)
      }
    }
  }

  private route(frame: CodexSharedServerFrame): void {
    const threadId = codexFrameThreadId(codexSharedFrameParams(frame))
    if (threadId === null) {
      this.routeServerWide(frame)
      return
    }
    frame.threadId = threadId
    const owner = this.owners.get(threadId)
    if (owner) {
      owner.liveThreads.add(threadId)
      owner.deliver(frame)
      return
    }
    if (this.retired.has(threadId)) {
      this.refuse(frame)
      return
    }
    if (this.recovery?.hold(threadId, frame)) {
      return
    }
    this.unrouted.hold(threadId, frame)
  }

  /** A frame no handler could read goes only to the chat that owns the thread it names, in order
   *  behind that chat's queue: raw content never reaches another chat. False when no chat took it. */
  onUnhandledFrame(frameKind: string, payload: unknown): boolean {
    const frame: CodexSharedServerFrame = { kind: 'unhandled', frameKind, payload, seq: this.seq() }
    const threadId = codexFrameThreadId(codexSharedFrameParams(frame))
    frame.threadId = threadId
    const owner = threadId === null ? undefined : this.owners.get(threadId)
    owner?.liveThreads.add(threadId!)
    owner?.deliver(frame)
    // A held chat's raw frame waits with the rest of its thread's.
    return (
      owner !== undefined || (threadId !== null && this.recovery?.hold(threadId, frame) === true)
    )
  }

  /** Account and rate-limit frames: each chat would have had its own copy from its own server. */
  private routeServerWide(frame: CodexSharedServerFrame): void {
    if (frame.kind === 'request') {
      // Any other request without a thread can't be tied to a chat; none may answer another's. A
      // reading chat answers first, so one paused chat can't hold the account's request.
      const open = SERVER_WIDE_REQUESTS.has(frame.request.method)
        ? [...this.leases()].filter((lease) => lease.open)
        : []
      const first = open.find((lease) => lease.reading) ?? open[0]
      if (first) {
        first.deliver(frame)
      } else {
        this.refuse(frame)
      }
      return
    }
    if (frame.kind !== 'notification' || !SERVER_WIDE_NOTIFICATIONS.has(frame.method)) {
      console.warn('[codex-shared-server] threadless frame reached no chat', frameMethod(frame))
      return
    }
    for (const lease of this.leases()) {
      lease.deliver(frame)
    }
  }
}

function frameMethod(frame: CodexSharedServerFrame): string {
  return frame.kind === 'notification'
    ? frame.method
    : frame.kind === 'request'
      ? frame.request.method
      : frame.frameKind
}
