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
    private readonly refuse: (frame: CodexSharedServerFrame) => void
  ) {
    this.unrouted = new CodexSharedServerUnrouted(refuse, () =>
      [...leases()].some((lease) => lease.pendingOpens.size > 0)
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
  claim(threadId: string, lease: CodexSharedServerLease, opened = false): void {
    const previous = this.owners.get(threadId)
    if (previous && previous !== lease) {
      previous.threads.delete(threadId)
    }
    this.owners.set(threadId, lease)
    lease.threads.add(threadId)
    // A chat that let this thread go no longer stops its turns: they are the new owner's now.
    for (const other of this.leases()) {
      if (other !== lease) {
        other.abandonedThreads.delete(threadId)
      }
    }
    this.retired.delete(threadId)
    for (const frame of this.unrouted.take(threadId)) {
      // A held frame can name helpers of its own; claim them (and replay theirs) before delivery.
      if (frame.kind === 'notification') {
        this.discover(frame.method, frame.params)
      }
      lease.deliver(frame)
    }
    // Its early frames were dropped to bound memory: the chat reopens it from Codex's history
    // rather than run on with events missing.
    if (this.unrouted.takeLost(threadId) && opened) {
      lease.shed()
    }
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
    this.route({ kind: 'notification', method, params })
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
      }
    }
  }

  onServerRequest(request: CodexAppServerServerRequest): void {
    this.route({ kind: 'request', request })
  }

  clear(): void {
    this.unrouted.clear()
    this.owners.clear()
  }

  /** A parent's item naming a helper hands that helper to the parent's chat. */
  private claimAnnouncedChildren(method: string, params: unknown): void {
    if (!method.startsWith('item/')) {
      return
    }
    const parent = codexFrameThreadId(params)
    const owner = parent ? this.owners.get(parent) : undefined
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
    const owner = this.owners.get(threadId)
    if (owner) {
      owner.deliver(frame)
      return
    }
    if (this.retired.has(threadId)) {
      this.refuse(frame)
      return
    }
    this.unrouted.hold(threadId, frame)
  }

  /** A frame no handler could read goes only to the chat that owns the thread it names, in order
   *  behind that chat's queue: raw content never reaches another chat. False when no chat took it. */
  onUnhandledFrame(frameKind: string, payload: unknown): boolean {
    const frame: CodexSharedServerFrame = { kind: 'unhandled', frameKind, payload }
    const threadId = codexFrameThreadId(codexSharedFrameParams(frame))
    const owner = threadId === null ? undefined : this.owners.get(threadId)
    owner?.deliver(frame)
    return owner !== undefined
  }

  /** Account and rate-limit frames: each chat would have had its own copy from its own server. */
  private routeServerWide(frame: CodexSharedServerFrame): void {
    if (frame.kind === 'request') {
      // Any other request without a thread can't be tied to a chat; none may answer another's.
      const first = SERVER_WIDE_REQUESTS.has(frame.request.method)
        ? [...this.leases()].find((lease) => lease.open)
        : undefined
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
