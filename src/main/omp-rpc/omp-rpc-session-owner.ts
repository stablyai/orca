import type {
  AgentSessionExecutionClaim,
  AgentSessionRpcOwnerBinding
} from '../../shared/agent-session-host-authority'
import type { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import { ClaimedAgentRpcSpawnError } from '../../shared/claimed-agent-rpc-owner'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import type {
  OmpRpcBaseSpawnOptions,
  OmpRpcSessionState,
  OmpSessionOwningRpcClient
} from '../../shared/omp-rpc-protocol'
import { spawnOmpRpcClient } from './omp-rpc-client'
import {
  OMP_RPC_INITIAL_READY_DEADLINE_MS,
  waitForOmpRpcInitialReady
} from './omp-rpc-initial-ready-deadline'
import { buildOmpRpcResumeLaunch, type OmpRpcResumeLaunchArgs } from './omp-rpc-resume-launch'
import {
  isOmpRpcSessionSettled,
  ompRpcErrorMessage,
  proveOmpRpcExit,
  waitForOmpRpcSettle,
  type OmpRpcOwnerExitVerdict,
  type OmpRpcSettleResult
} from './omp-rpc-session-settle-and-exit-proof'

export type { OmpRpcOwnerExitVerdict, OmpRpcSettleResult }

export type OmpRpcOwnedSession = {
  client: OmpSessionOwningRpcClient
  owner: AgentSessionRpcOwnerBinding & { phase: 'live' }
}

export type OmpRpcSessionAcquireResult =
  | { status: 'acquired'; session: OmpRpcOwnedSession }
  | { status: 'conflict'; reason: 'agent_session_conflict' }
  | { status: 'ownership-unknown'; reason: string }
  | {
      status: 'spawn-failed'
      reason: string
      exitVerdict?: OmpRpcOwnerExitVerdict
    }

export type OmpRpcToPtyHandoffResult =
  | {
      status: 'exited'
      sessionFile: string
      sessionId: string
      launchCommand: string
    }
  /** The child was already dead when the handoff began, so it never reported
   *  an identity to build a resume launch from. Terminal and safe: the claim
   *  is freed, and the pane's own respawn context supplies what this cannot. */
  | { status: 'already-exited'; reason: string }
  | Exclude<OmpRpcOwnerExitVerdict, { status: 'exited' }>
  | { status: 'ownership-unknown'; reason: string }

export type OmpRpcFromPtyHandoffResult =
  | OmpRpcSessionAcquireResult
  | Exclude<OmpRpcOwnerExitVerdict, { status: 'exited' }>

type OmpRpcSessionOwnerDependencies = {
  registry: ClaimedAgentPtyOwnerRegistry
  spawnClient?: (
    options: OmpRpcBaseSpawnOptions & { sessionMode: 'session-owning' }
  ) => OmpSessionOwningRpcClient
  proveRpcExit?: (client: OmpSessionOwningRpcClient) => Promise<OmpRpcOwnerExitVerdict>
  waitForSettle?: (client: OmpSessionOwningRpcClient) => Promise<OmpRpcSettleResult>
  buildResumeLaunch?: (args: OmpRpcResumeLaunchArgs) => string
  readyDeadlineMs?: number
}

export class OmpRpcSessionOwner {
  private readonly spawnClient: NonNullable<OmpRpcSessionOwnerDependencies['spawnClient']>
  private readonly proveRpcExit: NonNullable<OmpRpcSessionOwnerDependencies['proveRpcExit']>
  private readonly waitForSettle: NonNullable<OmpRpcSessionOwnerDependencies['waitForSettle']>
  private readonly buildResumeLaunch: NonNullable<
    OmpRpcSessionOwnerDependencies['buildResumeLaunch']
  >
  private readonly readyDeadlineMs: number
  /** Sessions whose claim this owner already freed (see `releaseClaim`). */
  private readonly releasedSessions = new WeakSet<OmpRpcOwnedSession>()

  constructor(private readonly dependencies: OmpRpcSessionOwnerDependencies) {
    this.spawnClient = dependencies.spawnClient ?? spawnOmpRpcClient
    this.proveRpcExit = dependencies.proveRpcExit ?? proveOmpRpcExit
    this.waitForSettle = dependencies.waitForSettle ?? waitForOmpRpcSettle
    this.buildResumeLaunch = dependencies.buildResumeLaunch ?? buildOmpRpcResumeLaunch
    this.readyDeadlineMs = dependencies.readyDeadlineMs ?? OMP_RPC_INITIAL_READY_DEADLINE_MS
  }

  async acquire(args: {
    claim: AgentSessionExecutionClaim
    spawnOptions: OmpRpcBaseSpawnOptions
    sessionFile?: string
    /** Runs iff initialization fails, the child's exit cannot be proven, and
     *  that exit is later observed (XLR-045, cross-lab review). Only this class
     *  ever sees that exit, and it is what makes the caller's own recovery
     *  (the pane owes its PTY back) safe to finish. */
    onLateExit?: () => void
  }): Promise<OmpRpcSessionAcquireResult> {
    if (args.claim.agent !== 'omp') {
      return {
        status: 'ownership-unknown',
        reason: 'agent_session_ownership_unknown'
      }
    }
    let claimed: Awaited<ReturnType<ClaimedAgentPtyOwnerRegistry['ensureRpc']>>
    try {
      claimed = await this.dependencies.registry.ensureRpc({
        claim: args.claim,
        spawn: () => this.spawnClient({ ...args.spawnOptions, sessionMode: 'session-owning' })
      })
    } catch (error) {
      return this.failedAcquisition(error)
    }

    const session: OmpRpcOwnedSession = {
      client: claimed.value as OmpSessionOwningRpcClient,
      owner: claimed.owner
    }
    try {
      await waitForOmpRpcInitialReady(session.client, this.readyDeadlineMs)
      if (args.sessionFile) {
        await session.client.switchSession(args.sessionFile)
        const state = await session.client.getState()
        if (state.sessionFile !== args.sessionFile) {
          throw new Error('OMP RPC child did not switch to the requested session')
        }
      }
      return { status: 'acquired', session }
    } catch (error) {
      return await this.cleanupFailedSpawn(session, error, args.onLateExit)
    }
  }

  /** Settles the release ordering: dispose -> prove exit -> release ->
   *  resume-launch (module doc). `allowAbort` defaults to false — a
   *  streaming turn is left running and this only waits (bounded, via
   *  `waitForSettle`) for it to settle on its own; the caller gets
   *  `unverifiable` back (claim kept, nothing disposed) if it never does.
   *  Critical B (cross-lab review, wave 5): the release-on-unmount path
   *  (leaving Chat view, pane force-close, app quit) must fail closed
   *  rather than silently aborting live work — only an explicit opt-in
   *  caller may set `allowAbort: true`. No caller does today; the flag
   *  exists so a future explicit "stop and switch" action can, without
   *  reintroducing an implicit abort on every release. */
  async handoffToPty(args: {
    session: OmpRpcOwnedSession
    baseCommand: string
    shell: AgentStartupShell
    allowAbort?: boolean
  }): Promise<OmpRpcToPtyHandoffResult> {
    let state: OmpRpcSessionState
    try {
      state = await args.session.client.getState()
      if (state.isStreaming && args.allowAbort) {
        await args.session.client.abort()
      }
      if (!isOmpRpcSessionSettled(state)) {
        const settled = await this.waitForSettle(args.session.client)
        if (settled.status === 'unverifiable') {
          // A child that stopped answering mid-poll gets the same exit
          // proof as one that was already unreachable at the first read —
          // the proof, not the silence, still decides. A turn that merely
          // ran long is live work and stays fail-closed here.
          return settled.cause === 'state-unreadable'
            ? await this.releaseProvenDeadSession(args.session, settled.reason)
            : { status: 'unverifiable', reason: settled.reason }
        }
        state = await args.session.client.getState()
        if (!isOmpRpcSessionSettled(state)) {
          // The settle observation went stale between `waitForSettle`
          // resolving and this read — a prompt/command accepted in that gap
          // is live work again, and disposing now would abort it silently
          // (Critical B). Fail closed; the claim stays held.
          return { status: 'unverifiable', reason: 'OMP RPC session resumed work before release' }
        }
      }
    } catch (error) {
      return await this.releaseProvenDeadSession(args.session, ompRpcErrorMessage(error))
    }

    const sessionFile = state.sessionFile?.trim()
    const sessionId = state.sessionId?.trim()
    if (!sessionFile || !sessionId) {
      return {
        status: 'ownership-unknown',
        reason: 'OMP RPC child did not report a complete session identity'
      }
    }

    args.session.client.dispose()
    const verdict = await this.proveExit(args.session.client)
    if (verdict.status !== 'exited') {
      // The child is already SIGTERMed, so this is the XLR-040 shape: the
      // caller keeps the session registered for a retry, but the claim must
      // not outlive a child that dies after the proof deadline.
      this.releaseClaimOnLateExit(args.session)
      return verdict
    }
    // Exit proof must precede release or a resumed PTY could overlap the RPC writer.
    if (!this.releaseClaim(args.session)) {
      return {
        status: 'ownership-unknown',
        reason: 'OMP RPC session claim changed before handoff release'
      }
    }
    try {
      const launchCommand = this.buildResumeLaunch({
        baseCommand: args.baseCommand,
        shell: args.shell,
        sessionFile,
        sessionId
      })
      return { status: 'exited', sessionFile, sessionId, launchCommand }
    } catch (error) {
      return { status: 'ownership-unknown', reason: ompRpcErrorMessage(error) }
    }
  }

  /** Teardown for a session the owner is retiring rather than handing back:
   *  SIGTERM the child, then free its claim only once the exit is proven
   *  (XLR-035/XLR-036, cross-lab review). `dispose()` alone signals the child
   *  and proves nothing, and the claim is the only thing keeping a second
   *  `omp --mode rpc` writer off that session file — so an unproven exit keeps
   *  it held, the same fail-closed verdict `handoffToPty` returns.
   *
   *  `provenOffSession` is the caller's own proof that the child can no longer
   *  write the claimed session (a read-back that saw it leave), which frees the
   *  claim without waiting on an exit the child need not have reached. Reports
   *  whether the claim was freed.
   *
   *  `onLateExit` runs iff this returns false and the child is later seen to
   *  exit (XLR-042, cross-lab review): the claim is not the only thing a
   *  retirement owes an unproven exit, and only this class observes the exit
   *  that finally settles it. */
  async disposeAndReleaseClaim(
    session: OmpRpcOwnedSession,
    provenOffSession = false,
    onLateExit?: () => void
  ): Promise<boolean> {
    session.client.dispose()
    const freed = provenOffSession || (await this.proveExit(session.client)).status === 'exited'
    if (freed) {
      this.releaseClaim(session)
    } else {
      this.releaseClaimOnLateExit(session, onLateExit)
    }
    return freed
  }

  async handoffFromPty(args: {
    claim: AgentSessionExecutionClaim
    sessionFile: string
    spawnOptions: OmpRpcBaseSpawnOptions
    provePtyExit: () => Promise<OmpRpcOwnerExitVerdict>
    onLateExit?: () => void
  }): Promise<OmpRpcFromPtyHandoffResult> {
    const ptyOwner = this.dependencies.registry.find(args.claim)
    let verdict: OmpRpcOwnerExitVerdict
    try {
      verdict = await args.provePtyExit()
    } catch (error) {
      return { status: 'unverifiable', reason: ompRpcErrorMessage(error) }
    }
    if (verdict.status !== 'exited') {
      return verdict
    }
    if (ptyOwner) {
      this.dependencies.registry.release(ptyOwner.ptyId, ptyOwner.generation)
    }
    return await this.acquire({
      claim: args.claim,
      spawnOptions: args.spawnOptions,
      sessionFile: args.sessionFile,
      ...(args.onLateExit ? { onLateExit: args.onLateExit } : {})
    })
  }

  /** A child whose commands all reject is either provably dead — nothing left
   *  to protect, so holding the claim only strands a pane that already has no
   *  PTY — or merely unreachable, e.g. a protocol fault while the process is
   *  still streaming to the session file. Only the exit proof separates them,
   *  so it still decides: it is never skipped, and the client is never
   *  disposed ahead of it (disposing an unreachable-but-live child is the
   *  "silently kill live work" outcome Critical B forbids). */
  private async releaseProvenDeadSession(
    session: OmpRpcOwnedSession,
    reason: string
  ): Promise<OmpRpcToPtyHandoffResult> {
    const verdict = await this.proveExit(session.client)
    if (verdict.status !== 'exited') {
      return verdict
    }
    session.client.dispose()
    if (!this.releaseClaim(session)) {
      return {
        status: 'ownership-unknown',
        reason: 'OMP RPC session claim changed before handoff release'
      }
    }
    return { status: 'already-exited', reason }
  }

  private failedAcquisition(error: unknown): OmpRpcSessionAcquireResult {
    if (error instanceof ClaimedAgentRpcSpawnError) {
      return { status: 'spawn-failed', reason: error.message }
    }
    const reason = ompRpcErrorMessage(error)
    if (reason === 'agent_session_conflict') {
      return { status: 'conflict', reason }
    }
    if (reason === 'agent_session_ownership_unknown' || reason === 'execution_owner_unavailable') {
      return { status: 'ownership-unknown', reason }
    }
    return { status: 'spawn-failed', reason }
  }

  private async cleanupFailedSpawn(
    session: OmpRpcOwnedSession,
    error: unknown,
    onLateExit?: () => void
  ): Promise<OmpRpcSessionAcquireResult> {
    session.client.dispose()
    const exitVerdict = await this.proveExit(session.client)
    if (exitVerdict.status === 'exited') {
      this.releaseClaim(session)
    } else {
      // Why `onLateExit` here too (XLR-045, cross-lab review): this failure
      // travels as `rpc-child-unverifiable`, which owes the pane NEITHER a
      // respawn nor the pre-kill undo — so the pane is left with no session and
      // no terminal, and the claim released below is the only thing the late
      // exit used to settle. The caller's bookkeeping rides the same exit.
      this.releaseClaimOnLateExit(session, onLateExit)
    }
    return { status: 'spawn-failed', reason: ompRpcErrorMessage(error), exitVerdict }
  }

  /** The exit proof is a deadline, and a SIGTERM-delayed child routinely
   *  outlives it (XLR-040, cross-lab review). The callers above have already
   *  forgotten the session by the time it finally dies, so nothing revisits
   *  the claim they fail-closed on — it outlived the child and conflicted
   *  every later acquisition of that session until app restart. Bind the
   *  release to the exit itself instead: `releaseRpc` is fenced on the exact
   *  claim + generation, so a successor that has since taken the same key is
   *  never touched. */
  private releaseClaimOnLateExit(session: OmpRpcOwnedSession, onLateExit?: () => void): void {
    void Promise.resolve(session.client.whenExited()).then(
      () => {
        this.releaseClaim(session)
        onLateExit?.()
      },
      () => {}
    )
  }

  /** Frees the session's claim exactly once. A retry that arrives after a
   *  late-exit binding already freed it must read as released, not as the
   *  "claim changed" fence — the fence is for a successor that took the key,
   *  and `releaseRpc` returning false cannot tell the two apart. */
  private releaseClaim(session: OmpRpcOwnedSession): boolean {
    if (this.releasedSessions.has(session)) {
      return true
    }
    const released = this.dependencies.registry.releaseRpc(session.owner)
    if (released) {
      this.releasedSessions.add(session)
    }
    return released
  }

  private async proveExit(client: OmpSessionOwningRpcClient): Promise<OmpRpcOwnerExitVerdict> {
    try {
      return await this.proveRpcExit(client)
    } catch (error) {
      return { status: 'unverifiable', reason: ompRpcErrorMessage(error) }
    }
  }
}
