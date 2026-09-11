import { OrcaRuntimeWithPtyObservationRouting } from './orca-runtime-pty-observation-routing'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import { collectPersistedTerminalLeafIds } from './mobile-session-layout-projection'
import { retiredTerminalSurfaceTitle } from './runtime-pty-replacement-identity-retirement'
import type { RetiredTerminalSurface } from './mobile-session-terminal-retirement'
import {
  latestAgentStatusRow,
  retiredPaneEvidenceFromRow,
  type RetiredPaneEvidence
} from './runtime-retired-pane-evidence'

/** The pane a spawn binds, in the same shape the commit resolved it. */
export type PtyPredecessorSurface = { worktreeId: string; tabId: string; leafId: string }

type RetiredPtyIncarnation = { ptyId: string; incarnationId: PtyIncarnationId }

type RetiredPaneEvidenceRecord = RetiredPaneEvidence & { successorPtyId: string }

/**
 * A pane that exits and is never respawned keeps its known-old until the pane is gone, and no
 * per-PTY reaper can see a pane-keyed entry. Oldest-first eviction is the honest bound: dropping a
 * record only means that pane's next terminal retires nothing, never a false retirement.
 */
export const MAX_RETIRED_PTY_PANES = 64

/**
 * Known-OLD identity for a pane's next terminal, and the durable retirement of what it replaces.
 *
 * Two host-authored records count, both scoped to the exact PTY that asks, so a record naming
 * another PTY or another pane is never read as this pane's predecessor. Absence is never proof:
 * a missing incarnation, a disconnect or a rotated handle leaves the pane with no predecessor.
 *
 * - the durable pane binding, while it still names this PTY — a relaunched host's known-old;
 * - a surface this runtime proved exited and then retired, because that retirement removes the
 *   durable binding (tab, layout and incarnation) BEFORE the successor registers, and this record
 *   is then the only surviving positive identity of the predecessor.
 */
export class OrcaRuntimeWithPtyReplacementDurableRetirement extends OrcaRuntimeWithPtyObservationRouting {
  /** Bounded by the panes one session actually retires; one record per pane. */
  private retiredPtyIncarnationByPaneKey = new Map<string, RetiredPtyIncarnation>()

  /**
   * The hook row a pane carried when this runtime proved its replacement, keyed by pane because
   * the pane outlives the process whose exit created the record. Deleted with the successor that
   * proved it, so it can never outlive the pane history it describes.
   */
  private retiredPaneEvidenceByPaneKey = new Map<string, RetiredPaneEvidenceRecord>()

  /**
   * Record the predecessor the host just proved gone, BEFORE the parent retires its durable
   * binding: once that binding (and its incarnation entry) is gone, this is the pane's only
   * surviving known-old. A live successor later supersedes it through the ordinary path.
   */
  protected override retireMobileSessionSurfacesForPty(
    ptyId: string,
    incarnationId: string,
    exactSurfaces: readonly Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>[]
  ): void {
    if (incarnationId) {
      for (const surface of exactSurfaces) {
        this.rememberRetiredPtyIncarnation(
          paneKeyOf(surface.worktreeId, surface.parentTabId, surface.leafId),
          ptyId,
          incarnationId
        )
      }
    }
    super.retireMobileSessionSurfacesForPty(ptyId, incarnationId, exactSurfaces)
  }

  private rememberRetiredPtyIncarnation(
    paneKey: string,
    ptyId: string,
    incarnationId: PtyIncarnationId
  ): void {
    // Re-insert so the eviction order below stays "oldest record first".
    this.retiredPtyIncarnationByPaneKey.delete(paneKey)
    this.retiredPtyIncarnationByPaneKey.set(paneKey, { ptyId, incarnationId })
    while (this.retiredPtyIncarnationByPaneKey.size > MAX_RETIRED_PTY_PANES) {
      const oldestPaneKey = this.retiredPtyIncarnationByPaneKey.keys().next().value
      if (oldestPaneKey === undefined) {
        return
      }
      this.retiredPtyIncarnationByPaneKey.delete(oldestPaneKey)
    }
  }

  /**
   * Drops the records this PTY owns: an unconsumed known-old created by its own exit, and the
   * predecessor evidence whose successor this PTY is. A pane that is closed instead of respawned
   * has no later exit, which is what the insert bound covers above.
   */
  protected forgetRetiredPtyRecordsForPty(ptyId: string): void {
    for (const [paneKey, retired] of this.retiredPtyIncarnationByPaneKey) {
      if (retired.ptyId === ptyId) {
        this.retiredPtyIncarnationByPaneKey.delete(paneKey)
      }
    }
    for (const [paneKey, evidence] of this.retiredPaneEvidenceByPaneKey) {
      if (evidence.successorPtyId === ptyId) {
        this.retiredPaneEvidenceByPaneKey.delete(paneKey)
      }
    }
  }

  /** The pane's pre-replacement hook evidence, while its successor still owns the pane. */
  protected override getRetiredPaneEvidence(paneKey: string): RetiredPaneEvidence | null {
    return this.retiredPaneEvidenceByPaneKey.get(paneKey) ?? null
  }

  protected readKnownPredecessorPaneIncarnationForPty(
    ptyId: string,
    surface: PtyPredecessorSurface
  ): PtyIncarnationId | null {
    const session = this.getWorkspaceSessionForWorktree(surface.worktreeId)
    const boundPtyId =
      session?.terminalLayoutsByTabId?.[surface.tabId]?.ptyIdsByLeafId?.[surface.leafId]
    if (boundPtyId !== undefined && boundPtyId !== ptyId) {
      // A binding that points elsewhere describes a different pane history.
      return null
    }
    const persisted =
      session?.terminalPtyIncarnationsByPaneKey?.[`${surface.tabId}:${surface.leafId}`]
    if (typeof persisted === 'string' && persisted.length > 0) {
      return persisted
    }
    const retired = this.retiredPtyIncarnationByPaneKey.get(
      paneKeyOf(surface.worktreeId, surface.tabId, surface.leafId)
    )
    return retired?.ptyId === ptyId ? retired.incarnationId : null
  }

  /**
   * Durable half of a proven replacement, run inside `registerPty` after binding
   * persistence/CAS and final registration and before the publication tail.
   *
   * Retires only predecessor-OWNED automatic identity: the pane's stale automatic surface
   * label (in the mobile snapshot AND its persisted re-seed) and the hook rows' live claims.
   * Custom/generated/default labels, split siblings, resume identity and history
   * addressability survive, and nothing here publishes `exited`.
   */
  protected retireReplacedPtyDurableIdentity(
    ptyId: string,
    surface: PtyPredecessorSurface,
    incarnationId?: PtyIncarnationId
  ): void {
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      // A foreground read of the replaced process says nothing about its successor; a live
      // successor re-proves it through the ordinary foreground refresh.
      pty.foregroundAgent = null
    }
    // Why here: this registration just persisted the successor's incarnation as the pane's
    // binding, which is the known-old the record existed to carry.
    this.retiredPtyIncarnationByPaneKey.delete(
      paneKeyOf(surface.worktreeId, surface.tabId, surface.leafId)
    )
    if (incarnationId !== undefined) {
      // Restored scrollback still carries the predecessor's title frames, so a seed derived
      // from it can never establish THIS incarnation's identity. Live output still can.
      this.retiredRestoreSeedIncarnationByPtyId.set(ptyId, incarnationId)
    }
    this.retireReplacedPaneSurfaceTitle(ptyId, surface)
    for (const leaf of this.getLeavesForPty(ptyId)) {
      // Graph reconciliation carries a leaf's pane title forward by PTY id alone, so no new
      // renderer frame is needed to put the predecessor's display title back on the successor.
      // A live successor re-proves its own through the ordinary graph sync.
      leaf.paneTitle = null
      leaf.paneTitleUpdatedAt = null
    }
    const paneKeys = this.collectPaneKeysForPty(ptyId)
    if (paneKeys.size > 0) {
      // The rows belong to a process the host itself replaced, so their live claims cannot be
      // stamped onto the successor handle. The resume remnant is preserved deliberately.
      this.reconcileAgentStatusForEndedProcessFn?.(paneKeys, { preserveResumeIdentity: true })
      this.rememberRetiredPaneEvidence(ptyId, paneKeys)
    }
  }

  /**
   * Record the row the retirement left in the pane's hook store, so the projection cannot
   * re-attribute the replaced process's evidence to the successor. The row itself stays for
   * resume; only its projection is fenced. A successor event always ingests afterwards with a new
   * stamp, so it is never matched, and one record per pane can never touch another pane.
   */
  private rememberRetiredPaneEvidence(ptyId: string, paneKeys: Iterable<string>): void {
    const readRows = this.getAgentProviderSessionRowsForPaneFn
    if (!readRows) {
      return
    }
    for (const paneKey of paneKeys) {
      const evidence = retiredPaneEvidenceFromRow(latestAgentStatusRow(readRows(paneKey)))
      if (evidence) {
        this.retiredPaneEvidenceByPaneKey.set(paneKey, { ...evidence, successorPtyId: ptyId })
      }
    }
  }

  private retireReplacedPaneSurfaceTitle(ptyId: string, surface: PtyPredecessorSurface): void {
    const { worktreeId, tabId, leafId } = surface
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    const persistedTabs = session?.tabsByWorktree?.[worktreeId]
    const persistedTab = persistedTabs?.find((tab) => tab.id === tabId) ?? null
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    let snapshotChanged = false
    const tabs = (snapshot?.tabs ?? []).map((tab) => {
      if (
        tab.type !== 'terminal' ||
        tab.parentTabId !== tabId ||
        tab.leafId !== leafId ||
        (tab.ptyId !== undefined && tab.ptyId !== ptyId)
      ) {
        return tab
      }
      const retired = retiredTerminalSurfaceTitle(tab.title, persistedTab)
      if (retired === null) {
        return tab
      }
      snapshotChanged = true
      return { ...tab, title: retired }
    })
    if (snapshot && snapshotChanged) {
      this.storeMobileSessionSnapshot(worktreeId, {
        ...snapshot,
        snapshotVersion: snapshot.snapshotVersion + 1,
        tabs
      })
      this.notifyMobileSessionTabsChanged(worktreeId)
    }
    if (!session || !persistedTabs || !persistedTab) {
      return
    }
    // Why also the persisted row: the headless projection falls back to it, so leaving the
    // retired label there re-seeds it on the next hydrate. One tab title covers every split
    // sibling, so a multi-leaf tab keeps its label — only this leaf's surface was replaced.
    const layout = session.terminalLayoutsByTabId?.[tabId]
    if (collectPersistedTerminalLeafIds(layout).filter((id) => id !== leafId).length > 0) {
      return
    }
    const retired = retiredTerminalSurfaceTitle(persistedTab.title, persistedTab)
    if (retired === null) {
      return
    }
    this.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [worktreeId]: persistedTabs.map((tab) =>
          tab.id === tabId ? { ...tab, title: retired } : tab
        )
      }
    })
  }
}

/** A tab id is unique, so worktree + pane key identifies the successor's own records. */
function paneKeyOf(worktreeId: string, tabId: string, leafId: string): string {
  return `${worktreeId}\u0000${tabId}:${leafId}`
}
