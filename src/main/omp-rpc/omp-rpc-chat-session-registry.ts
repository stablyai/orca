// Per-pane registry of proof-gated RPC-owned OMP chat sessions.
//
// Scoped to its OWN ClaimedAgentPtyOwnerRegistry + ephemeral claim signer,
// deliberately NOT the runtime's global PTY-claim registry (which is used for
// cross-host/mobile execution claims, not plain local panes — plain local OMP
// panes never register a claim there today). Real dual-writer safety comes
// from the liveness check above, not from cross-registry conflict detection.
// See docs/omp-rpc-chat-adapter-plan.md for the full scoping rationale.
import type { AgentSessionExecutionClaim } from '../../shared/agent-session-host-authority'
import { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import type { OmpRpcBaseSpawnOptions } from '../../shared/omp-rpc-protocol'
import {
  canonicalizeAgentSessionIdentity,
  createEphemeralAgentSessionClaimSigner,
  type AgentSessionClaimSigner
} from '../runtime/agent-session-claim-identity'
import { OmpRpcChatSession } from './omp-rpc-chat-session'
import { ompRpcAcquireIdentityKey } from './omp-rpc-acquire-identity-key'
import { trackPendingChildExit } from './omp-rpc-pending-child-exit-barrier'
import { OmpRpcChatSessionReadbackReconciler } from './omp-rpc-chat-session-readback-reconciler'
import { disposeOmpRpcChatSessionRegistry } from './omp-rpc-chat-session-shutdown'
import { ptyExitVerdict } from './omp-rpc-pty-exit-verdict'
import { OmpRpcSessionOwner } from './omp-rpc-session-owner'
import { OMP_RPC_LOCAL_NAMESPACE, OMP_RPC_LOCAL_WORKTREE_SCOPE } from './omp-rpc-local-claim-scope'
import { OmpRpcLocalSessionWriteFence } from './omp-rpc-local-session-write-fence'
export type OmpRpcChatAcquireArgs = {
  paneKey: string
  ptyId: string
  cwd: string
  executablePath: string
  commandArgs?: string[]
  /** OMP resumes by session id (#8962) — this is the claim identity, never
   *  passed to the wire protocol directly. */
  sessionFile: string
  /** F12 live probe (ORCA_OMP_RPC_LIVE=1, omp-rpc-live.test.ts): `omp`'s
   *  `switch_session` requires the absolute session FILE path — a bare
   *  session id does not throw, but silently fails to switch (`sessionFile`
   *  on the resulting `get_state()` never matches). Resolved by the IPC
   *  handler from `sessionFile` via `resolveSessionFilePath`. */
  sessionFilePath: string
  /** Read-only liveness query for `ptyId` — true/false/null (unverifiable),
   *  matching the SSH execution boundary's live/unverifiable/exited vocabulary. */
  isPtyAlive: (ptyId: string) => boolean | null
  hasOtherPtySessionWriter?: (sessionFilePath: string, ptyId: string) => Promise<boolean>
  /** Fired when an acquisition that failed as `rpc-child-unverifiable` finally
   *  sees that child exit (XLR-045, cross-lab review). That refusal owes the
   *  pane neither a respawn nor the pre-kill undo, so it is left with no
   *  session AND no terminal — the exit is the moment resuming its PTY becomes
   *  safe, and this is the only signal the pane ever gets. */
  onLateRpcChildExit?: () => void
}
/** What a retirement needs from the acquisition that created the session it is
 *  retiring (XLR-R6-002, cross-lab review): the pane's key, and the late-exit
 *  notification that is the pane's ONLY signal once the registration carrying
 *  its release answer is gone. A retirement removes the session and fires a
 *  fatal frame; the renderer's one release request answers `released: false`
 *  because neither a session nor an owed marker exists yet, and the marker
 *  added later by the proven exit reached nobody — leaving the pane faulted
 *  with no RPC owner and no PTY. */
export type OmpRpcChatPaneHandbackContext = Pick<
  OmpRpcChatAcquireArgs,
  'paneKey' | 'ptyId' | 'hasOtherPtySessionWriter' | 'onLateRpcChildExit'
>
export type OmpRpcChatAcquireResult =
  | { status: 'acquired'; session: OmpRpcChatSession }
  | { status: 'live' }
  | { status: 'unverifiable'; reason: string }
  /** The RPC CHILD's exit could not be proven, so it may still be writing the
   *  session — while `ptyId` is provably exited, because that proof is what
   *  admitted the spawn in the first place. A verdict on a different process
   *  than `live`/`unverifiable` speak for, and it has to stay distinguishable
   *  from them (XLR-041/XLR-043, cross-lab review): those two say "the pane's
   *  PTY may still be alive", which is what makes the renderer disarm its exit
   *  suppression and re-point the pane at that PTY. Here the pane owes neither
   *  a respawn (a second writer beside the child) nor that restore (a terminal
   *  that is provably gone). */
  | { status: 'rpc-child-unverifiable'; reason: string }
  | { status: 'conflict' }
  | { status: 'spawn-failed'; reason: string }
/** Why: `launchCommand`/`sessionFile`/`sessionId` used to be built here on the
 *  `exited` path, but no caller ever threaded a real `resumeContext` or read
 *  them (F10) — PTY auto-resume-on-release is a separate, still-pending
 *  product decision. Re-add them only alongside a real consumer. */
export type OmpRpcChatReleaseResult = {
  released: boolean
  /** The session the child reported at release time (XLR-019, cross-lab
   *  review) — `handoffToPty` reads and validates it before disposing, so it is
   *  the only identity main can prove. Absent when the child died before it
   *  could report one ('already-exited'), which is the only case a caller may
   *  fall back to its own acquisition-time id for. */
  sessionId?: string
}
export class OmpRpcChatSessionRegistry {
  private readonly ptyOwnerRegistry = new ClaimedAgentPtyOwnerRegistry()
  private readonly claimSigner: AgentSessionClaimSigner =
    createEphemeralAgentSessionClaimSigner('omp-rpc-chat')
  private readonly owner: OmpRpcSessionOwner
  private readonly sessionsByPaneKey = new Map<string, OmpRpcChatSession>()
  private readonly claimsByPaneKey = new Map<string, AgentSessionExecutionClaim>()
  // Why (finding C, cross-lab review): exposed via
  // `claimedSessionFilePathsExcluding()` so the identity resolver's mtime
  // fallback (omp-terminal-session-identity.ts) can exclude a session
  // another live pane already claimed, before a second pane sharing the
  // same cwd bucket is ever offered it.
  private readonly sessionFilePathsByPaneKey = new Map<string, string>()
  private readonly sessionIdsByPaneKey = new Map<string, string>()
  // Why (XLR-R3-001, cross-lab review): `cwd` is the other half of the
  // acquisition identity and is immutable in the spawned child, so the reuse
  // check below needs it too — a session file alone cannot tell a rebind to
  // another working directory apart from a re-acquire of the same one, and
  // reusing the old child there runs every prompt and tool in the OLD
  // directory. Written only where a child is registered, and never deleted:
  // a read-back switch cannot move it, and an entry left behind by a released
  // pane is unreachable, because the check below runs only for a pane that
  // still HAS a registered session — which always rewrote this first.
  private readonly cwdsByPaneKey = new Map<string, string>()
  // Why (F5): acquire/release for one paneKey must never race each other or
  // themselves — an in-flight release holds the RPC claim up to the 15s
  // settle+exit-proof window, and React StrictMode double-mounts fire two
  // concurrent acquires for the same identity. `generationByPaneKey` lets a
  // slower acquire that started against a since-superseded identity (an
  // in-flight rebind, not just a release) detect it lost and dispose itself
  // instead of publishing a stale session over a newer one.
  private readonly pendingAcquireByPaneKey = new Map<
    string,
    { identityKey: string; promise: Promise<OmpRpcChatAcquireResult> }
  >()
  private readonly pendingReleaseByPaneKey = new Map<string, Promise<OmpRpcChatReleaseResult>>()
  // A failed acquire can have spawned a child without ever registering a
  // session. App quit must join that child's late physical-exit signal too.
  private readonly pendingUnregisteredChildExits = new Set<Promise<void>>()
  private readonly generationByPaneKey = new Map<string, number>()
  // Monotonic across the whole registry, and never restarted (XLR-R5-002,
  // cross-lab review): `disposeAll` clears the map above, so a per-pane count
  // handed a FRESH acquire the same generation a pre-disposal acquire was still
  // holding — both passed the fence, both returned `acquired`, and the older
  // child was left registered by nobody and disposed by nobody.
  private generationCounter = 0
  // Why (XLR-030): a session this registry retired itself (a switch-adoption
  // conflict) leaves the pane with no child AND no PTY, because acquisition
  // killed it. The pane's release is what carries the hand-back request, so the
  // grant has to survive the registration this retirement just deleted —
  // otherwise that release reports `released: false` and no PTY ever returns.
  private readonly handbackOwedPaneKeys = new Set<string>()
  private readonly writerFencesByPaneKey = new Map<string, { path: string; owner: string }>()
  private readonly writerFence: OmpRpcLocalSessionWriteFence
  private readonly readbackReconciler: OmpRpcChatSessionReadbackReconciler
  constructor(
    dependencies: Omit<ConstructorParameters<typeof OmpRpcSessionOwner>[0], 'registry'> & {
      writerFence?: OmpRpcLocalSessionWriteFence
    } = {}
  ) {
    this.writerFence = dependencies.writerFence ?? new OmpRpcLocalSessionWriteFence()
    this.owner = new OmpRpcSessionOwner({
      registry: this.ptyOwnerRegistry,
      ...dependencies
    })
    this.readbackReconciler = new OmpRpcChatSessionReadbackReconciler({
      generationByPaneKey: this.generationByPaneKey,
      sessionsByPaneKey: this.sessionsByPaneKey,
      claimsByPaneKey: this.claimsByPaneKey,
      sessionFilePathsByPaneKey: this.sessionFilePathsByPaneKey,
      sessionIdsByPaneKey: this.sessionIdsByPaneKey,
      writerFencesByPaneKey: this.writerFencesByPaneKey,
      handbackOwedPaneKeys: this.handbackOwedPaneKeys,
      writerFence: this.writerFence,
      ptyOwnerRegistry: this.ptyOwnerRegistry,
      claimSigner: this.claimSigner,
      owner: this.owner,
      claimedSessionFilePathsExcluding: (paneKey) => this.claimedSessionFilePathsExcluding(paneKey)
    })
  }

  /** Why the release exclusion (XLR-005, cross-lab review): `handoffToPty`
   *  disposes the child on the strength of a settle observation, and every
   *  command surface (send/abort/respondExtensionUi/fetchHistory/subscribe)
   *  reaches the child through here. Without excluding them for the whole
   *  release window, a prompt accepted after the settle proof but before the
   *  dispose is killed silently — the exact outcome Critical B forbids. A
   *  release that fails closed re-admits them when it clears the flag. */
  get(paneKey: string): OmpRpcChatSession | null {
    if (this.pendingReleaseByPaneKey.has(paneKey)) {
      return null
    }
    return this.sessionsByPaneKey.get(paneKey) ?? null
  }

  getSessionFile(paneKey: string): string | null {
    return this.get(paneKey) === null ? null : (this.sessionIdsByPaneKey.get(paneKey) ?? null)
  }

  /** Session file paths currently claimed by a live pane OTHER than
   *  `paneKey` (finding C, hardened wave 9 Defect 2) — read by the identity
   *  resolver's mtime-fallback candidate scan so a session another pane
   *  already owns is never offered to a second pane sharing the same cwd
   *  bucket, while the asking pane's own claim is never held against it
   *  (proven live: without the exclusion, a pane re-resolving its own
   *  identity while holding it was silently handed a different, older
   *  session). */
  claimedSessionFilePathsExcluding(paneKey: string): ReadonlySet<string> {
    const claimed = new Set<string>()
    for (const [ownerPaneKey, sessionFilePath] of this.sessionFilePathsByPaneKey) {
      if (ownerPaneKey !== paneKey) {
        claimed.add(sessionFilePath)
      }
    }
    return claimed
  }

  async acquire(args: OmpRpcChatAcquireArgs): Promise<OmpRpcChatAcquireResult> {
    const identityKey = ompRpcAcquireIdentityKey(args.cwd, args.sessionFile, args.sessionFilePath)
    const pendingAcquire = this.pendingAcquireByPaneKey.get(args.paneKey)
    if (pendingAcquire && pendingAcquire.identityKey === identityKey) {
      return pendingAcquire.promise
    }
    const generation = (this.generationCounter += 1)
    this.generationByPaneKey.set(args.paneKey, generation)
    const promise = this.performAcquire(args, generation)
    this.pendingAcquireByPaneKey.set(args.paneKey, { identityKey, promise })
    return await promise.finally(() => {
      if (this.pendingAcquireByPaneKey.get(args.paneKey)?.promise === promise) {
        this.pendingAcquireByPaneKey.delete(args.paneKey)
      }
    })
  }

  private async performAcquire(
    args: OmpRpcChatAcquireArgs,
    generation: number
  ): Promise<OmpRpcChatAcquireResult> {
    // Why a loop: while this acquire awaited one release, another acquire on
    // the same paneKey can have started a second one; reading the map after
    // only the first settles could hand back a session that release is about
    // to dispose.
    for (
      let pendingRelease = this.pendingReleaseByPaneKey.get(args.paneKey);
      pendingRelease;
      pendingRelease = this.pendingReleaseByPaneKey.get(args.paneKey)
    ) {
      await pendingRelease
    }
    const existing = this.sessionsByPaneKey.get(args.paneKey)
    const heldSessionFilePath = this.sessionFilePathsByPaneKey.get(args.paneKey)
    const heldCwd = this.cwdsByPaneKey.get(args.paneKey)
    if (existing && heldSessionFilePath === args.sessionFilePath && heldCwd === args.cwd) {
      return { status: 'acquired', session: existing }
    }
    // A rebind must retire its stale claim before retrying acquisition.
    if (existing && !(await this.release(args.paneKey)).released) {
      return { status: 'conflict' }
    }
    if (await args.hasOtherPtySessionWriter?.(args.sessionFilePath, args.ptyId)) {
      return { status: 'conflict' }
    }
    let claim: AgentSessionExecutionClaim
    try {
      const identity = canonicalizeAgentSessionIdentity('omp', {
        key: 'session_id',
        id: args.sessionFile
      })
      claim = this.claimSigner.createClaim({
        namespace: OMP_RPC_LOCAL_NAMESPACE,
        identity,
        canonicalWorktreeId: OMP_RPC_LOCAL_WORKTREE_SCOPE
      })
    } catch (error) {
      return {
        status: 'spawn-failed',
        reason: error instanceof Error ? error.message : String(error)
      }
    }
    const spawnOptions: OmpRpcBaseSpawnOptions = {
      executablePath: args.executablePath,
      cwd: args.cwd,
      ...(args.commandArgs ? { commandArgs: args.commandArgs } : {})
    }
    const ptyVerdict = ptyExitVerdict(args.ptyId, args.isPtyAlive)
    if (ptyVerdict.status === 'live' || ptyVerdict.status === 'unverifiable') {
      return ptyVerdict
    }
    const writerFenceOwner = `${args.paneKey}:${generation}`
    if (!this.writerFence.reserve(args.sessionFilePath, writerFenceOwner)) {
      return { status: 'conflict' }
    }
    const releaseWriterFence = (): void =>
      this.writerFence.release(args.sessionFilePath, writerFenceOwner)
    let resolveUnregisteredChildExit!: () => void
    const unregisteredChildExit = new Promise<void>((resolve) => {
      resolveUnregisteredChildExit = resolve
    })
    const result = await this.owner.handoffFromPty({
      claim,
      sessionFile: args.sessionFilePath,
      spawnOptions,
      provePtyExit: () => Promise.resolve(ptyExitVerdict(args.ptyId, args.isPtyAlive)),
      // XLR-045: a failed initialization whose child exit is unprovable strands
      // this pane with no session and no PTY. Bind its recovery to the exit
      // itself — the same late-exit seam a retirement rides.
      onLateExit: () => {
        releaseWriterFence()
        this.readbackReconciler.oweHandbackAfterProvenExit(args.paneKey, args.onLateRpcChildExit)
        resolveUnregisteredChildExit()
      }
    })
    if (result.status === 'acquired') {
      let session!: OmpRpcChatSession
      session = new OmpRpcChatSession(result.session, args.sessionFilePath, async (readback) =>
        this.readbackReconciler.reconcile(args, generation, session, readback)
      )
      // Why: a slower acquire for a paneKey whose identity has since been
      // rebound or released must never overwrite the newer session — dispose
      // the loser instead (F5 / cross-lab HIGH_2). Its claim outlives the
      // dispose until the exit is proven (XLR-035): SIGTERM is not an exit, and
      // freeing the claim early let another pane spawn a second writer against
      // a session file this child may still be writing.
      //
      // Why the split verdict (XLR-043, cross-lab review): this registry's
      // claim is deliberately private, so it blocks another RPC acquisition and
      // nothing else — it cannot stop an ordinary `omp --resume` PTY. A plain
      // `conflict` is exactly what the renderer's killed-PTY recovery reads as
      // "no RPC writer ever started", and it then spawns that PTY directly. A
      // superseded child whose exit is unproven may still be writing the
      // session, so the report has to say so.
      if (this.generationByPaneKey.get(args.paneKey) !== generation) {
        const freed = await this.owner.disposeAndReleaseClaim(
          session.owned,
          false,
          () => {
            releaseWriterFence()
            resolveUnregisteredChildExit()
          }
        )
        session.dispose()
        if (freed) {
          releaseWriterFence()
        } else {
          trackPendingChildExit(this.pendingUnregisteredChildExits, unregisteredChildExit)
        }
        return freed ? { status: 'conflict' } : { status: 'rpc-child-unverifiable', reason: 'superseded OMP RPC child exit unproven' }
      }
      this.sessionsByPaneKey.set(args.paneKey, session)
      this.claimsByPaneKey.set(args.paneKey, claim)
      this.sessionFilePathsByPaneKey.set(args.paneKey, args.sessionFilePath)
      this.sessionIdsByPaneKey.set(args.paneKey, args.sessionFile)
      this.cwdsByPaneKey.set(args.paneKey, args.cwd)
      this.writerFencesByPaneKey.set(args.paneKey, {
        path: args.sessionFilePath,
        owner: writerFenceOwner
      })
      // A fresh child owns this pane's hand-back obligation now; an older
      // retirement's owed grant would resume a PTY beside it.
      this.handbackOwedPaneKeys.delete(args.paneKey)
      return { status: 'acquired', session }
    }
    if (result.status === 'live' || result.status === 'unverifiable') {
      releaseWriterFence()
      return result
    }
    if (result.status === 'conflict' || result.status === 'ownership-unknown') {
      releaseWriterFence()
      return { status: 'conflict' }
    }
    // Why (XLR-038, cross-lab review): a failed initialization whose cleanup
    // could NOT prove the RPC child exited leaves a possible writer on this
    // session. `spawn-failed` reads to the renderer as "nothing started", so
    // `recoverPtyAfterRefusedOmpRpcAcquire` respawns `omp --resume` beside it —
    // the dual-writer outcome this feature is proof-gated to prevent. Report
    // the cleanup's own verdict, which is the fail-closed one that excludes
    // the respawn.
    //
    // Under its own status, never the PTY's `unverifiable` (XLR-041, cross-lab
    // review): `args.ptyId` is provably EXITED on this path — that proof is
    // what admitted the spawn — so borrowing the verdict that means "the pane's
    // PTY may still be alive" made the renderer disarm its exit suppression and
    // rebind the pane to a terminal it had already killed, instead of leaving
    // the pane owed nothing until the child's exit becomes observable.
    if (result.exitVerdict && result.exitVerdict.status !== 'exited') {
      trackPendingChildExit(this.pendingUnregisteredChildExits, unregisteredChildExit)
      return { status: 'rpc-child-unverifiable', reason: result.exitVerdict.reason }
    }
    releaseWriterFence()
    return { status: 'spawn-failed', reason: result.reason }
  }

  /** Proof-gated: disposes the RPC child and releases the claim only once
   *  `handoffToPty` proves the turn settled and the child genuinely exited
   *  (Critical B, wave 5) — never unconditionally, which would silently
   *  kill a still-streaming turn. A child that had already exited before
   *  the release began settles the same gate by proof rather than by
   *  waiting. A release that cannot prove either fails closed
   *  (`released: false`), keeping the session registered. Tracked
   *  in `pendingReleaseByPaneKey` so a concurrent `acquire` for the same
   *  pane waits for this to finish instead of racing it into a spurious
   *  `agent_session_conflict` (F5) — the claim stays held for the whole
   *  settle+exit-proof window below, not just until this method returns. */
  async release(paneKey: string): Promise<OmpRpcChatReleaseResult> {
    // Single-flight (XLR-046, cross-lab review): cleanup and a reclaiming
    // acquire routinely ask to release the same pane at once. Starting a second
    // release ran a second `handoffToPty` against the child the first is
    // already disposing, and the two shared one uncounted "releasing" flag — so
    // whichever finished first re-admitted command surfaces while the other
    // release was still live, exactly the window that flag exists to close.
    // Joining is also the honest answer: there is one child, so there is one
    // release, and both callers learn what it proved.
    const pending = this.pendingReleaseByPaneKey.get(paneKey)
    if (pending) {
      return await pending
    }
    const promise = this.performRelease(paneKey)
    this.pendingReleaseByPaneKey.set(paneKey, promise)
    return await promise.finally(() => {
      this.pendingReleaseByPaneKey.delete(paneKey)
    })
  }

  private async performRelease(paneKey: string): Promise<OmpRpcChatReleaseResult> {
    const session = this.sessionsByPaneKey.get(paneKey)
    if (!session) {
      // A retirement this registry performed already disposed the child and
      // freed the claim, so the release is complete — but the pane still has no
      // PTY, and `released: true` is the only answer that makes the IPC layer
      // push the hand-back (XLR-030).
      return this.handbackOwedPaneKeys.delete(paneKey) ? { released: true } : { released: false }
    }
    // Why (XLR-029): an already-authorized session-switching command can be
    // sitting between its response and the registry's adoption of the new
    // identity. A handoff that settles inside that window disposes the child,
    // releases the OLD claim, and reports the CONTESTED session for hand-back —
    // so a resumed PTY lands beside the pane whose live RPC child owns it. The
    // adoption (and its own conflict retirement) has to decide first.
    if (!(await session.whenSessionIdentitySettled())) {
      return { released: false }
    }
    if (this.sessionsByPaneKey.get(paneKey) !== session) {
      return this.handbackOwedPaneKeys.delete(paneKey) ? { released: true } : { released: false }
    }
    const result = await this.owner.handoffToPty({
      session: session.owned,
      baseCommand: 'omp',
      shell: process.platform === 'win32' ? 'cmd' : 'posix'
    })
    if (result.status !== 'exited' && result.status !== 'already-exited') {
      // Why (Critical B, cross-lab review): fail closed. A turn that never
      // proves settled/exited within handoffToPty's bounded wait must keep
      // holding the RPC claim, not have its (possibly still-streaming)
      // child force-disposed out from under it — the OLD code disposed and
      // released unconditionally here regardless of this result, which is
      // exactly the "silently kill live work" bug this wave fixes. The
      // session stays registered so a later release attempt, or a
      // returning acquire (which finds and reuses it), can still act on it.
      return { released: false }
    }
    // 'already-exited' is the child that died on its own (crash, external
    // kill): handoffToPty still proved the exit before freeing anything, so
    // it is as complete a release as 'exited' — just without a resume
    // launch to report, which no caller reads (F10). Keeping the
    // registration instead would leak the claim AND this pane's
    // session-file exclusion for the app's life, leaving a pane that
    // acquisition already stripped of its PTY with no way back.
    //
    // Both terminal paths inside handoffToPty already disposed the client
    // and released the ptyOwner claim before returning — nothing to force
    // here.
    this.sessionsByPaneKey.delete(paneKey)
    this.claimsByPaneKey.delete(paneKey)
    this.sessionFilePathsByPaneKey.delete(paneKey)
    this.sessionIdsByPaneKey.delete(paneKey)
    const writerFence = this.writerFencesByPaneKey.get(paneKey)
    if (writerFence) {
      this.writerFence.release(writerFence.path, writerFence.owner)
      this.writerFencesByPaneKey.delete(paneKey)
    }
    session.dispose()
    // Why the identity (XLR-019): a supported command can have switched the
    // child's session since acquisition, and this result is the only place the
    // proven one reaches the caller — dropping it made hand-back resume the
    // renderer's stale acquisition-time id and silently abandon the
    // conversation that was live when the release completed.
    return result.status === 'exited'
      ? { released: true, sessionId: result.sessionId }
      : { released: true }
  }
  /** Unlike `release` (which waits on `handoffToPty`'s settle-then-exit
   *  ordering and can fail closed, keeping the claim), app quit cannot wait for
   *  a turn to SETTLE — dispose the transport (the only thing that SIGTERMs the
   *  child), release the claim, then the session's own listener teardown, so an
   *  app quit mid-turn cannot orphan an `omp --mode rpc` child that keeps
   *  writing the session (F4/D2).
   *
   *  It does wait for the EXIT, which is why this resolves rather than
   *  returning void (XLR-R6-005): sending SIGTERM is not disposal, and the
   *  caller must join this into the application's teardown barrier so
   *  `app.quit()` cannot beat the child's death. */
  disposeAll(): Promise<void> {
    // Why (XLR-R4-002, cross-lab review): disposal can only reach a REGISTERED
    // session, and an acquire spends its whole readiness/switch/get_state
    // window spawned but unregistered. Leaving its pane generation valid let
    // that acquire publish its child into this disposed registry afterwards —
    // an `omp --mode rpc` writer with no shutdown owner left to dispose it.
    // Clearing the generations makes every in-flight acquire lose its own
    // fence, so it disposes the child it was about to register instead, while a
    // FRESH acquire still gets a generation of its own and succeeds — the
    // counter it draws from never restarts (XLR-R5-002).
    return disposeOmpRpcChatSessionRegistry({
      sessions: this.sessionsByPaneKey, ptyOwnerRegistry: this.ptyOwnerRegistry,
      pendingAcquires: [...this.pendingAcquireByPaneKey.values()].map(({ promise }) => promise), pendingUnregisteredChildExits: this.pendingUnregisteredChildExits,
      claims: this.claimsByPaneKey, sessionFilePaths: this.sessionFilePathsByPaneKey,
      sessionIds: this.sessionIdsByPaneKey, handbackOwedPaneKeys: this.handbackOwedPaneKeys,
      generations: this.generationByPaneKey, writerFences: this.writerFencesByPaneKey,
      writerFence: this.writerFence
    })
  }
}
