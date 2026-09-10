// A single RPC-owned OMP chat session for one pane: forwards raw turn-lifecycle
// frames to registered listeners and exposes a fail-closed send surface
// (prompt/steer/follow_up/abort/respondExtensionUi) for the IPC layer to drive.

import type {
  OmpRpcClientEvent,
  OmpRpcExtensionUiResponse,
  OmpRpcImageContent
} from '../../shared/omp-rpc-protocol'
// The IPC contract owns this union; a second local copy could drift from the
// verb mapping below, which is the one place it is interpreted.
import type {
  OmpRpcChatFetchHistoryResult,
  OmpRpcChatSendBehavior,
  OmpRpcChatSendResult
} from '../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcSubagentSubscriptionLevel } from '../../shared/omp-rpc-subagent-protocol'
import { decodeOmpRpcHistoryMessages } from './omp-rpc-history-decode'
import { OMP_RPC_COMMAND_RESPONSE_TIMEOUT_MS } from './omp-rpc-transport-limits'
import type { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import type { OmpRpcOwnedSession } from './omp-rpc-session-owner'

export type { OmpRpcChatFetchHistoryResult, OmpRpcChatSendBehavior, OmpRpcChatSendResult }

/** See the constructor note: `events`, the only level that carries the child
 *  streams the roster row renders. */
export const OMP_RPC_CHAT_SUBAGENT_SUBSCRIPTION_LEVEL: OmpRpcSubagentSubscriptionLevel = 'events'

/** The session the child is actually in, read back off `get_state` after a
 *  command that may have moved it. `sessionFilePath` is the claim identity the
 *  registry keys its registration and its cross-pane exclusion on. */
export type OmpRpcChatSessionIdentity = {
  sessionFilePath: string
  sessionId: string | null
}

/** What a post-command identity read-back actually proved (XLR-028). An
 *  `unreadable` verdict is NOT the same as "unchanged": the command already ran,
 *  so the switch upstream never announces may already have happened, and the
 *  claim main keeps publishing can no longer be trusted. */
export type OmpRpcChatSessionIdentityReadback =
  | { kind: 'identity'; sessionFilePath: string; sessionId: string }
  | { kind: 'unreadable'; reason: string }

export class OmpRpcChatSession {
  private readonly listeners = new Set<(event: OmpRpcClientEvent) => void>()
  private readonly unsubscribeClient: () => void
  private isDisposed = false
  /** Latest `available_commands_update`, retained for replay. It is the
   *  renderer's only proof of which slash commands this session can execute,
   *  and it must survive the gap between arrival and subscription. */
  private commandsEvent: (OmpRpcClientEvent & { kind: 'commands' }) | null = null
  /** The first fatal frame — `exit` or `protocol-fault` — retained for replay
   *  (XLR-R5-001, cross-lab review). The child can die between acquisition and
   *  the renderer's asynchronous subscribe IPC, and a fatal frame emitted into
   *  that gap reached no listener at all: the pane stayed 'acquired' and kept
   *  routing sends to a dead child instead of asking its killed PTY back. It is
   *  terminal state rather than a stream, so only the first one is kept. */
  private fatalEvent: Extract<OmpRpcClientEvent, { kind: 'exit' | 'protocol-fault' }> | null = null
  /** Resolves once no post-command identity read-back is still in flight — see
   *  `whenSessionIdentitySettled`. */
  private identitySettled: Promise<void> = Promise.resolve()
  /** Notified when a command round trip finishes — see `onCommandSettled`. */
  private readonly commandSettledListeners = new Set<() => void>()

  constructor(
    readonly owned: OmpRpcOwnedSession,
    /** The session file this pane acquired. Null only for callers that never
     *  claimed one (tests); a null bound path reconciles nothing. */
    private boundSessionFilePath: string | null = null,
    /** Invoked with what a post-command identity read-back proved, so the owner
     *  of the claim can follow the child — or retire it when the identity could
     *  not be read at all. See `reconcileSessionIdentity`. */
    private readonly onSessionIdentityReadback?: (
      readback: OmpRpcChatSessionIdentityReadback
    ) => unknown
  ) {
    this.unsubscribeClient = owned.client.on((event) => this.emit(event))
    // Why: OMP pushes its startup available_commands_update while the child is
    // still booting — before this session exists — so the catalog has to be
    // asked for once. Failure is silent, but not harmless: with no catalog the
    // renderer cannot prove any command runs over RPC and refuses the session
    // route entirely, so this fetch is what makes that route usable at all.
    void owned.client.getCommands().catch(() => undefined)
    // Subagent forwarding defaults to `off` upstream, so a pane that never asks
    // sees no subagent frame at all. `events` is the level this surface needs:
    // `progress` stops at lifecycle + aggregated status, and the child's own
    // event stream is the ONLY source for what a subagent is running and saying
    // right now, which the roster row renders (omp-rpc-subagent-roster.ts). The
    // extra traffic is the child's token stream; the roster keeps a bounded tail
    // of it rather than accumulating. Failure is silent and safe — the roster
    // simply stays empty.
    void owned.client
      .setSubagentSubscription(OMP_RPC_CHAT_SUBAGENT_SUBSCRIPTION_LEVEL)
      .catch(() => undefined)
    // No idle-recap reconnect hydration here on purpose: the shipped runtime
    // publishes no recap at all, so there is nothing to recover. See
    // docs/omp-rpc-dependency-followups.md.
  }

  /** Exposed for tests: the retained catalog event, or null if none arrived. */
  get latestCommandsEvent(): OmpRpcClientEvent | null {
    return this.commandsEvent
  }

  on(listener: (event: OmpRpcClientEvent) => void): () => void {
    this.listeners.add(listener)
    // A subscriber that attached after the catalog landed still needs it; the
    // catalog is session state, not a turn event, so replay is correct.
    if (this.commandsEvent) {
      listener(this.commandsEvent)
    }
    // Last, and after the catalog: a subscriber that attached into the gap
    // above must still see the transport die, or nothing retires this pane.
    if (this.fatalEvent) {
      listener(this.fatalEvent)
    }
    return () => this.listeners.delete(listener)
  }

  /** Reconnect history hydration: drains the owned session's paged history and
   *  decodes it into the same shape the transcript reader produces, so the
   *  renderer can rank the two instead of showing a gap. Fail-closed like
   *  `send` — `session-busy` is upstream refusing to page while streaming or
   *  compacting, and stays distinguishable so the caller can retry once idle. */
  async fetchHistory(options: { limit?: number } = {}): Promise<OmpRpcChatFetchHistoryResult> {
    try {
      const result = await this.owned.client.fetchHistory(options)
      return result.kind === 'session-busy'
        ? { ok: false, reason: 'session-busy' }
        : {
            ok: true,
            messages: decodeOmpRpcHistoryMessages(result.messages),
            totalMessages: result.totalMessages
          }
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
  }

  /** Idle sends `prompt`; `steer` interrupts the in-progress turn; `follow_up`
   *  queues for after it settles. Matches OMP TUI send conventions (D6).
   *  `command` also sends `prompt` — the only verb that executes a builtin or
   *  skill slash command upstream — and always carries `streamingBehavior`,
   *  which OMP requires while a turn is streaming and reads ONLY inside its
   *  `if (this.isStreaming)` branch (agent-session.ts), so it is a no-op on an
   *  idle session rather than something the renderer must predict. */
  send(args: {
    message: string
    images?: OmpRpcImageContent[]
    behavior: OmpRpcChatSendBehavior
    /** Pins the wire `id` so the caller can correlate OMP's later
     *  `prompt_result` echo with the run that sent this message. */
    requestId?: string
  }): Promise<OmpRpcChatSendResult> {
    if (args.behavior !== 'command') {
      return this.performSend(args)
    }
    // Why (XLR-029): only a COMMAND can move the child's session, and the move
    // is adopted after its response lands — so the whole round trip, not just
    // the read-back, is the window release must join. Armed synchronously here
    // (never with its rejection) so a release starting right after this call
    // still sees the gate closed.
    const run = this.performSend(args)
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    this.identitySettled = settled
    // Chained on the same promise the gate reads, so a listener woken here
    // always finds that gate already open.
    void settled.then(() => {
      for (const listener of this.commandSettledListeners) {
        listener()
      }
    })
    return run
  }

  /** Fires when a command round trip and its identity read-back finish — the
   *  ONE settlement this session reports through no frame at all (XLR-R7-002,
   *  cross-lab review). A local-only slash or extension command runs no agent,
   *  so it emits no `agent-end`/`turn-end`, and a same-session read-back
   *  publishes no `session-info` either; a release refused purely because
   *  command identity had not settled would otherwise never be retried, and
   *  main would keep the child, its claim, and its session-file exclusion for
   *  the app's life. Never replayed: a listener hears only completions that
   *  happen after it attaches, which is what keeps the retry from spinning. */
  onCommandSettled(listener: () => void): () => void {
    this.commandSettledListeners.add(listener)
    return () => this.commandSettledListeners.delete(listener)
  }

  private async performSend(args: {
    message: string
    images?: OmpRpcImageContent[]
    behavior: OmpRpcChatSendBehavior
    requestId?: string
  }): Promise<OmpRpcChatSendResult> {
    const requestId = args.requestId === undefined ? {} : { requestId: args.requestId }
    try {
      const result =
        args.behavior === 'idle'
          ? await this.owned.client.prompt(args.message, { images: args.images, ...requestId })
          : args.behavior === 'command'
            ? await this.owned.client.prompt(args.message, {
                images: args.images,
                streamingBehavior: 'steer',
                ...requestId
              })
            : args.behavior === 'steer'
              ? await this.owned.client.steer(args.message, args.images)
              : await this.owned.client.followUp(args.message, args.images)
      if (args.behavior === 'command') {
        await this.reconcileSessionIdentity()
      }
      return { ok: true, agentInvoked: result.agentInvoked }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Waits for the in-flight command round trip and its identity read-back to
   *  finish, reporting whether they did (XLR-029). Release must join this
   *  before proving a settle: an already-authorized session-switching command
   *  sits between its response and the registry's adoption of the new identity,
   *  and a handoff that runs inside that window disposes the child, frees the
   *  OLD claim, and reports the contested session for PTY hand-back — putting a
   *  resumed terminal beside the live RPC child that really owns it.
   *
   *  Bounded, because upstream answers `prompt` only once the skill or builtin
   *  it dispatched has finished and that request deliberately carries no
   *  response deadline (omp-rpc-transport-limits.ts). An unbounded join would
   *  leave the release pending forever, and with it every command surface the
   *  release excludes. `false` is the same fail-closed verdict live work earns
   *  from `handoffToPty` itself. */
  whenSessionIdentitySettled(
    timeoutMs: number = OMP_RPC_COMMAND_RESPONSE_TIMEOUT_MS
  ): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const timer = setTimeout(() => resolve(false), timeoutMs)
    void this.identitySettled.then(() => resolve(true))
    return promise.finally(() => clearTimeout(timer))
  }

  /** Why (XLR-018, cross-lab review): the command route runs whatever OMP
   *  publishes, including extension commands whose handlers create, branch, or
   *  switch sessions — and upstream announces none of it, since
   *  `handleRpcSessionChange` emits only `available_commands_update` and no
   *  `session_info_update`. Reporting success without reading the identity back
   *  left the registry claiming (and excluding from every other pane) the
   *  session this pane acquired while the child wrote a different one: a second
   *  pane could then be handed the live session, producing two writers. The
   *  read-back is published on the same `session-info` channel a real
   *  `session_info_update` uses, so the renderer's existing
   *  published-id-outranks-the-on-disk-guess precedence retires the stale
   *  identity with no new wire shape.
   *
   *  A read that FAILS is not evidence the child stayed put (XLR-028): the
   *  command already ran, so the unannounced switch may already have happened
   *  and main would keep claiming — and excluding from every other pane — a
   *  session nobody writes while a second pane is handed the live one. So the
   *  unreadable verdict goes to the claim owner as its own outcome (it retires
   *  the child, the only fail-closed answer the wire protocol offers) and this
   *  throws, which is what turns the send into a reported failure. */
  private async reconcileSessionIdentity(): Promise<void> {
    let sessionFilePath: string | undefined
    let sessionId: string | null = null
    try {
      const state = await this.owned.client.getState()
      sessionFilePath = state.sessionFile?.trim()
      sessionId = state.sessionId?.trim() || null
    } catch (error) {
      await this.reportUnreadableSessionIdentity(
        error instanceof Error ? error.message : String(error)
      )
      return
    }
    if (!sessionFilePath) {
      // An identity-less child cannot be proven still on the bound session
      // either — `handoffToPty` already calls this same shape ownership-unknown.
      await this.reportUnreadableSessionIdentity('child reported no session file')
      return
    }
    if (sessionFilePath === this.boundSessionFilePath) {
      return
    }
    if (!sessionId) {
      // The child moved to a session it names no id for. The registry transfers
      // its claim by id, so it could neither adopt nor publish this session and
      // would keep publishing the acquisition path while the child writes
      // elsewhere — the same unprovable state as a failed read.
      await this.reportUnreadableSessionIdentity(
        `child switched to ${sessionFilePath} without a session id`
      )
      return
    }
    await this.onSessionIdentityReadback?.({ kind: 'identity', sessionFilePath, sessionId })
    this.boundSessionFilePath = sessionFilePath
    this.emit({ kind: 'session-info', title: null, sessionId })
  }

  private async reportUnreadableSessionIdentity(reason: string): Promise<void> {
    // A session that never claimed a path (tests) has nothing to reconcile
    // against, so there is no claim to fail closed on.
    if (this.boundSessionFilePath === null) {
      return
    }
    await this.onSessionIdentityReadback?.({ kind: 'unreadable', reason })
    throw new Error(`omp_rpc_session_identity_unreadable: ${reason}`)
  }

  async abort(): Promise<OmpRpcChatSendResult> {
    try {
      await this.owned.client.abort()
      return { ok: true, agentInvoked: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Fire-and-forget: false only means the transport can't accept writes right
   *  now (disposed/exited) — OMP resolves a pending dialog to a default on its
   *  own timeout, so a dropped reply is safe by design, not a hang. Wrapped
   *  in try/catch to match `send`/`abort`'s fail-closed contract (F7) rather
   *  than relying on every layer below independently never throwing. */
  respondExtensionUi(response: OmpRpcExtensionUiResponse): boolean {
    try {
      return this.owned.client.respondExtensionUi(response)
    } catch {
      return false
    }
  }

  /** Tells this session's subscribers the owner retired it out from under them
   *  (XLR-030). Reuses the fatal-frame channel the renderer's ownership hook
   *  already reacts to, so a retirement is never silent: without it the pane
   *  stays 'acquired' and keeps routing sends to a main that has no session. */
  emitRetirement(reason: string): void {
    this.emit({ kind: 'protocol-fault', message: reason })
  }

  /** App-quit teardown (F4/D2): SIGTERM the child through the transport (the
   *  only thing that does), free its claim, then drop the listeners. Still
   *  proof-free about the SETTLE — a quit cannot wait on the settle-then-exit
   *  ordering a release owes, which is why this is never the release path.
   *
   *  But it does wait on the EXIT (XLR-R6-005, cross-lab review): a SIGTERM the
   *  child delays or ignores is not disposal, and the transport escalates to
   *  SIGKILL only on an unref'd timer. Returning before that lands let
   *  `will-quit` reach `app.quit()` first, leaving an `omp --mode rpc` child
   *  still writing the session — and a relaunched Orca could then put a PTY or
   *  a fresh RPC child on it as a second writer. The returned promise is what
   *  joins the application's teardown barrier, whose own deadline is the bound
   *  here: an exit that never arrives must not make Force Quit the only way
   *  out (quit-teardown-deadline.ts). */
  forceDisposeForShutdown(ptyOwnerRegistry: ClaimedAgentPtyOwnerRegistry): Promise<void> {
    const exited = Promise.resolve(this.owned.client.whenExited()).then(
      () => undefined,
      () => undefined
    )
    this.owned.client.dispose()
    ptyOwnerRegistry.releaseRpc(this.owned.owner)
    this.dispose()
    return exited
  }

  dispose(): void {
    if (this.isDisposed) {
      return
    }
    this.isDisposed = true
    this.unsubscribeClient()
    this.listeners.clear()
    this.commandSettledListeners.clear()
  }

  private emit(event: OmpRpcClientEvent): void {
    if (event.kind === 'commands') {
      this.commandsEvent = event
    }
    if (event.kind === 'exit' || event.kind === 'protocol-fault') {
      this.fatalEvent ??= event
    }
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}
