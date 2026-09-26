import { OrcaRuntimeWithRecordPtyWorktree } from './orca-runtime-record-pty-worktree'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { restoredTerminalTailSeedAllowed } from './terminal-tail-restore-seed'

// Why a bound: the provider maps a failed snapshot to null, the same answer as a title-less
// session or an older daemon, so a transient failure gets a retry but a real null stays cheap.
const ADOPTED_PTY_TITLE_SEED_MAX_PROBES = 3
// Why a delay: a burst of inventory refreshes would otherwise spend every retry on one outage.
const ADOPTED_PTY_TITLE_SEED_RETRY_DELAY_MS = 10_000

// `retryAt` is null while a probe is in flight.
type AdoptedPtyTitleSeedProbes = { attempt: string; probes: number; retryAt: number | null }

export class OrcaRuntimeWithSeedAdoptedPtyRestoreTitle extends OrcaRuntimeWithRecordPtyWorktree {
  // Keyed by record so a pruned record drops its probes; `attempt` names the PTY incarnation.
  private readonly adoptedPtyTitleSeedProbes = new WeakMap<
    RuntimePtyWorktreeRecord,
    AdoptedPtyTitleSeedProbes
  >()

  /**
   * Seeds the last title of a live session adopted from the controller inventory.
   *
   * Why: a headless runtime restart adopts surviving daemon sessions without a spawn, so the
   * restore title the spawn paths seed never arrives and idle agents read as unknown.
   * Why title only: adoption does not attach the session, so no live bytes follow a seed. A
   * seeded tail would freeze preview/read/tui-idle evidence that the provider fallbacks keep fresh.
   */
  protected seedAdoptedPtyRestoreTitle(pty: RuntimePtyWorktreeRecord): void {
    // Why local only: SSH relay providers serve no buffer snapshot, so asking is pure overhead.
    if (!this.ptyController?.serializeProviderBuffer || pty.connectionId !== null) {
      return
    }
    const ptyId = pty.ptyId
    const attempt = this.adoptedPtyTitleSeedAttempt(pty)
    const previous = this.adoptedPtyTitleSeedProbes.get(pty)
    const current = previous?.attempt === attempt ? previous : null
    if (
      current &&
      (current.probes >= ADOPTED_PTY_TITLE_SEED_MAX_PROBES ||
        current.retryAt === null ||
        Date.now() < current.retryAt)
    ) {
      return
    }
    // Why: live bytes, a tracked title, or a spawn-path seed already gave this record its state.
    if (
      !restoredTerminalTailSeedAllowed(pty) ||
      this.getTrackedRawTitleForPty(ptyId) !== null ||
      (this.leavesByPtyId.get(ptyId) ?? []).some((leaf) => !restoredTerminalTailSeedAllowed(leaf))
    ) {
      return
    }
    const probe: AdoptedPtyTitleSeedProbes = {
      attempt,
      probes: (current?.probes ?? 0) + 1,
      retryAt: null
    }
    this.adoptedPtyTitleSeedProbes.set(pty, probe)
    // Why fire-and-forget: the inventory listing is a hot path and must not wait on a snapshot.
    // A title-less answer leaves the record seedable, so a later inventory refresh probes again.
    void this.applyAdoptedPtyRestoreTitle(pty, attempt)
      .catch(() => {})
      .finally(() => {
        probe.retryAt = Date.now() + ADOPTED_PTY_TITLE_SEED_RETRY_DELAY_MS
      })
  }

  /**
   * Drops a restored title when the inventory reports a new incarnation for the same PTY id.
   *
   * Why: spawns record their own incarnation, so only a respawn the runtime missed reaches here,
   * and a title restored for the process it replaced says nothing about its successor.
   * Why restored only: a title observed live is current evidence, and the successor's own output
   * can arrive through a viewer's attach before the inventory reports its incarnation.
   */
  protected forgetRestoredPtyTitle(pty: RuntimePtyWorktreeRecord): void {
    const restoredTitle = pty.lastOscTitle
    if (restoredTitle === null || pty.lastOscTitleEpochMs !== null) {
      return
    }
    this.disposePtyTitleTracker(pty.ptyId)
    // Why kept, every one: a renderer pane republishes the title it showed on every graph sync,
    // and repeated respawns with no live title between them leave older echoes standing.
    const replaced = restoredTitle.trim()
    if (!pty.replacedRestoredTitles?.includes(replaced)) {
      pty.replacedRestoredTitles = [...(pty.replacedRestoredTitles ?? []), replaced]
    }
    pty.lastOscTitle = null
    pty.lastOscTitleAt = null
    pty.managementTitle = null
    pty.managementTitleAt = null
    if (!pty.lastAgentStatusObservedLive) {
      pty.lastAgentStatus = null
    }
    // Panes bound since the restore copied its title.
    for (const leaf of this.leavesByPtyId.get(pty.ptyId) ?? []) {
      if (leaf.lastOscTitle !== restoredTitle) {
        continue
      }
      leaf.lastOscTitle = null
      leaf.lastOscTitleAt = null
      if (!leaf.lastAgentStatusObservedLive) {
        leaf.lastAgentStatus = null
      }
    }
  }

  private adoptedPtyTitleSeedAttempt(pty: RuntimePtyWorktreeRecord): string {
    return `${this.getPtyLifecycleGeneration(pty.ptyId)}:${pty.incarnationId ?? ''}`
  }

  private async applyAdoptedPtyRestoreTitle(
    pty: RuntimePtyWorktreeRecord,
    attempt: string
  ): Promise<void> {
    const ptyId = pty.ptyId
    // Why direct, not the shared acquisition: that one is keyed by lifecycle generation, so a
    // replacement incarnation adopted mid-flight would join the predecessor's frame.
    // Why zero rows: only the title is used, so skip serializing scrollback.
    const snapshot = await this.ptyController?.serializeProviderBuffer?.(ptyId, {
      scrollbackRows: 0
    })
    // Why: a snapshot is only valid for the record and incarnation that asked.
    if (
      !snapshot?.lastTitle ||
      this.ptysById.get(ptyId) !== pty ||
      !pty.connected ||
      this.adoptedPtyTitleSeedAttempt(pty) !== attempt
    ) {
      return
    }
    // The seed already lets a title observed live while this was in flight win.
    this.seedTerminalRestoreTail(ptyId, { lastTitle: snapshot.lastTitle })
  }
}
