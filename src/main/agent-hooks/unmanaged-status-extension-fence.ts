import { createHash } from 'node:crypto'
import type { AgentHookSource } from '../../shared/agent-hook-relay'

// Why: Pi/OMP auto-discover every extension file in the agent's extensions dir, and Orca
// side-loads its managed copy with `-e` whenever a user-owned file already holds that name
// (writeManagedExtension refuses to overwrite an unmarked file). Both copies then run in the
// same process and post the same pane's status, but an unmanaged copy is frozen at whatever
// Orca version produced it, so it can post a completion the managed copy deliberately withheld
// and settle a pane that is still working.
//
// Orca's managed extension stamps ORCA_AGENT_LAUNCH_TOKEN into every post body; an unmanaged
// copy predating that field cannot. That is the only reliable in-band discriminator, because
// both copies share the process, the pane key, and the endpoint credentials.
//
// Why suppression is provisional, never permanent: "a tokened post was seen once" is evidence
// that a managed poster *existed*, not that one is *live*. A managed poster that posts once and
// then dies would otherwise gate every later post on that pane forever, and a pane stuck on
// "working" is invisible and has no user recovery. So a tokenless post is HELD, not dropped:
// a following tokened post discards it (and is the proof that two posters share the pane —
// that is the only thing worth warning about), and silence past the confirmation window
// re-opens the gate and delivers it. Anything else that removes an owner — including the LRU
// eviction below — releases the hold with it, because eviction is not a delivery event.
// A held post is therefore superseded, delivered, or dropped with the turn it described when
// the pane itself is retired; only that last case ends a hold without a post reaching the pane.

/** Panes tracked before the oldest owner is evicted; eviction re-opens that pane's gate. */
export const MAX_TRACKED_PANES = 512

/**
 * How long a held tokenless post waits for the managed poster to contradict it.
 *
 * Why this long: both copies run in one process off one hook event, so the managed copy's
 * superseding post lands in the same millisecond band as the unmanaged one (the measured
 * ordering was unmanaged-first by a hair). Even the deliberately-withheld `agent_end` is
 * re-checked every 25–250ms until idle, and an auto-continuation posts `agent_start` as
 * soon as it is scheduled. 30s is orders of magnitude above that and far below the 30min
 * AGENT_STATUS_STALE_AFTER_MS at which Orca stops believing a "working" claim anyway, so a
 * lapse means the managed poster is gone rather than merely quiet.
 */
export const UNMANAGED_POST_CONFIRMATION_WINDOW_MS = 30_000

export type UnmanagedStatusExtensionReport = {
  paneKey: string
  source: AgentHookSource
}

export type StatusPostOrigin =
  /** Carries a launch token: this is the process Orca launched, and it now owns the pane. */
  | 'managed'
  /** No token while a token-carrying poster owns the pane: held pending confirmation. */
  | 'held'
  /** No token and no established owner: indistinguishable from a normal tokenless launch. */
  | 'unattributed'

type HeldPost = {
  timer: ReturnType<typeof setTimeout>
  release: () => void
}

/**
 * Tells Orca's own status extension apart from a second one loaded alongside it.
 *
 * Only ever holds a *tokenless* post, and only while a token-carrying poster owns the same pane
 * and source. A tokened post is never rejected, so a relaunch always takes the pane back, and a
 * held post is always resolved — superseded by the managed poster, delivered when it goes silent
 * for {@link UNMANAGED_POST_CONFIRMATION_WINDOW_MS}, or delivered when the owner is evicted by
 * {@link MAX_TRACKED_PANES}. Two paths end a hold without delivering it, and neither can leave a
 * pane claiming finished work: pane retirement closes the pane's row in the same step, and server
 * teardown is app quit, after which the row comes back explicitly unconfirmed — see {@link dispose}.
 */
export class UnmanagedStatusExtensionFence {
  private ownerHashByPaneKey = new Map<string, Map<AgentHookSource, string>>()
  private reportedSourcesByPaneKey = new Map<string, Set<AgentHookSource>>()
  private heldPostsByPaneKey = new Map<string, Map<AgentHookSource, HeldPost>>()
  private onDetected: ((report: UnmanagedStatusExtensionReport) => void) | null = null

  constructor(private confirmationWindowMs: number = UNMANAGED_POST_CONFIRMATION_WINDOW_MS) {}

  /** Test seam: the production window is far longer than any suite should wait on. */
  setConfirmationWindowMsForTests(windowMs: number): void {
    this.confirmationWindowMs = windowMs
  }

  setDetectionListener(listener: ((report: UnmanagedStatusExtensionReport) => void) | null): void {
    this.onDetected = listener
  }

  /**
   * @param release re-delivers this post if the managed poster never contradicts it. Omitting it
   *   makes the hold a plain drop, so callers that cannot replay must not gate on this fence.
   */
  classify(
    paneKey: string,
    source: AgentHookSource | undefined,
    launchToken: string | undefined,
    release?: () => void
  ): StatusPostOrigin {
    if (!source || paneKey.length === 0) {
      return 'unattributed'
    }
    const token = launchToken?.trim() ?? ''
    if (token.length > 0) {
      this.rememberOwner(paneKey, source, createHash('sha256').update(token).digest('hex'))
      // Why here: a tokened post arriving while a tokenless one is held is the whole proof —
      // two posters, one Orca launched and one it did not, interleaved on one pane.
      if (this.discardHeldPost(paneKey, source)) {
        this.reportOnce(paneKey, source)
      }
      return 'managed'
    }
    if (!this.ownerHashByPaneKey.get(paneKey)?.has(source)) {
      return 'unattributed'
    }
    if (!release) {
      return 'unattributed'
    }
    this.holdPost(paneKey, source, release)
    return 'held'
  }

  /** Pane teardown: drop the owner so a key reused by a tokenless launch starts from an open gate. */
  forgetPane(paneKey: string): void {
    this.ownerHashByPaneKey.delete(paneKey)
    this.reportedSourcesByPaneKey.delete(paneKey)
    this.discardPaneHolds(paneKey)
  }

  /**
   * Server shutdown: a held post must not outlive the server that would deliver it. Dropping it
   * cannot strand the pane, because nothing held here is what the next launch reads. What survives is
   * the pane's persisted status row, and hydrate re-stamps every non-`done` row `restoredUnconfirmed`
   * (`server.ts`), which `isFreshNonDoneAgentStatus` refuses to read as live work until a live post
   * replaces it.
   */
  dispose(): void {
    for (const held of this.heldPostsByPaneKey.values()) {
      for (const entry of held.values()) {
        clearTimeout(entry.timer)
      }
    }
    this.heldPostsByPaneKey.clear()
    this.ownerHashByPaneKey.clear()
    this.reportedSourcesByPaneKey.clear()
  }

  private holdPost(paneKey: string, source: AgentHookSource, release: () => void): void {
    // Why latest-only: an older held post describes a state the newer one already supersedes.
    this.discardHeldPost(paneKey, source)
    const timer = setTimeout(() => {
      this.discardHeldPost(paneKey, source)
      // Why before release: the replay re-enters classify, and a still-armed gate would hold it
      // again forever. Dropping the owner is also the point — the managed poster proved absent.
      this.forgetOwner(paneKey, source)
      release()
    }, this.confirmationWindowMs)
    timer.unref?.()
    const held = this.heldPostsByPaneKey.get(paneKey) ?? new Map<AgentHookSource, HeldPost>()
    held.set(source, { timer, release })
    this.heldPostsByPaneKey.set(paneKey, held)
  }

  private discardHeldPost(paneKey: string, source: AgentHookSource): boolean {
    const held = this.heldPostsByPaneKey.get(paneKey)
    const entry = held?.get(source)
    if (!held || !entry) {
      return false
    }
    clearTimeout(entry.timer)
    held.delete(source)
    if (held.size === 0) {
      this.heldPostsByPaneKey.delete(paneKey)
    }
    return true
  }

  /** Removes every hold on a pane and hands back their releases, so a caller can resolve them. */
  private takePaneHolds(paneKey: string): (() => void)[] {
    const held = this.heldPostsByPaneKey.get(paneKey)
    if (!held) {
      return []
    }
    const releases: (() => void)[] = []
    for (const entry of held.values()) {
      clearTimeout(entry.timer)
      releases.push(entry.release)
    }
    this.heldPostsByPaneKey.delete(paneKey)
    return releases
  }

  /** Retirement only: the held post describes the turn that just ended, so it must not be replayed. */
  private discardPaneHolds(paneKey: string): void {
    this.takePaneHolds(paneKey)
  }

  private reportOnce(paneKey: string, source: AgentHookSource): void {
    const reported = this.reportedSourcesByPaneKey.get(paneKey)
    if (reported?.has(source)) {
      return
    }
    if (reported) {
      reported.add(source)
    } else {
      this.reportedSourcesByPaneKey.set(paneKey, new Set([source]))
    }
    this.onDetected?.({ paneKey, source })
  }

  private forgetOwner(paneKey: string, source: AgentHookSource): void {
    const sources = this.ownerHashByPaneKey.get(paneKey)
    if (!sources) {
      return
    }
    sources.delete(source)
    if (sources.size === 0) {
      this.ownerHashByPaneKey.delete(paneKey)
    }
  }

  private rememberOwner(paneKey: string, source: AgentHookSource, hash: string): void {
    // Why: re-insert so the Map's insertion order stays a usable LRU for the cap below.
    const existing = this.ownerHashByPaneKey.get(paneKey)
    this.ownerHashByPaneKey.delete(paneKey)
    const sources = existing ?? new Map<AgentHookSource, string>()
    sources.set(source, hash)
    this.ownerHashByPaneKey.set(paneKey, sources)
    const stranded: (() => void)[] = []
    while (this.ownerHashByPaneKey.size > MAX_TRACKED_PANES) {
      const oldest = this.ownerHashByPaneKey.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.ownerHashByPaneKey.delete(oldest)
      this.reportedSourcesByPaneKey.delete(oldest)
      // Why release, not discard: eviction is not a delivery event, so a post destroyed with it
      // has nothing left to resolve it. Losing the owner is the lapse case — the gate re-opens.
      stranded.push(...this.takePaneHolds(oldest))
    }
    // Why after the loop: a release re-enters classify, which must not run mid-eviction.
    for (const release of stranded) {
      release()
    }
  }
}
