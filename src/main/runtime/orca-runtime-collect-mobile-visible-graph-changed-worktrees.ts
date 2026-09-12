// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithSyncWindowGraph } from './orca-runtime-sync-window-graph'
import type { RuntimeMobileSessionTabsResult, RuntimeSyncedTab } from '../../shared/runtime-types'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import type { PtyControllerInventory } from './runtime-pty-controller-contract'
import { parseExecutionHostId } from '../../shared/execution-host'
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'

// Give up forcing a resync for a worktree after this many no-reply attempts, so a
// renderer that never answers can't add a 10s round trip to every subsequent list.
const MAX_MOBILE_RESYNC_ATTEMPTS = 3

export class OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees extends OrcaRuntimeWithSyncWindowGraph {
  // Why: toMobileSessionTabsResult resolves handles/titles from this.tabs and
  // this.leaves, so any tab/leaf delta a graph sync installs can flip the
  // client payload (pending-handle → ready, tab title) with zero change to the
  // stored snapshot. Compare exactly the projection-relevant fields and report
  // the affected worktrees; false positives only cost a coalesced no-op emit.
  protected collectMobileVisibleGraphChangedWorktrees(
    previousTabs: Map<string, RuntimeSyncedTab>,
    previousLeaves: Map<string, RuntimeLeafRecord>
  ): Set<string> {
    const changed = new Set<string>()
    for (const [tabId, tab] of this.tabs) {
      const prev = previousTabs.get(tabId)
      if (!prev || prev.title !== tab.title) {
        changed.add(tab.worktreeId)
      }
    }
    for (const [tabId, tab] of previousTabs) {
      if (!this.tabs.has(tabId)) {
        changed.add(tab.worktreeId)
      }
    }
    for (const [leafKey, leaf] of this.leaves) {
      const prev = previousLeaves.get(leafKey)
      if (
        !prev ||
        prev.ptyId !== leaf.ptyId ||
        prev.connected !== leaf.connected ||
        prev.paneTitle !== leaf.paneTitle
      ) {
        changed.add(leaf.worktreeId)
      }
    }
    for (const [leafKey, leaf] of previousLeaves) {
      if (!this.leaves.has(leafKey)) {
        changed.add(leaf.worktreeId)
      }
    }
    return changed
  }

  async listMobileSessionTabs(
    worktreeSelector: string,
    clientNavigationId?: string
  ): Promise<RuntimeMobileSessionTabsResult> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    if (explicitWorktreeId) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(explicitWorktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(explicitWorktreeId)
      await this.refreshMobileSessionPtyRecords(explicitWorktreeId)
      this.restoreLivePairedRendererSessionOwnedMobileTerminals(explicitWorktreeId)
      this.reconcileMobileSessionBrowserTabsOnInitialList(explicitWorktreeId)
      await this.requestRendererGraphResync(explicitWorktreeId)
      return this.getMobileSessionTabsForWorktree(explicitWorktreeId, clientNavigationId)
    }
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id)
    await this.refreshMobileSessionPtyRecords()
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(worktree.id)
    this.reconcileMobileSessionBrowserTabsOnInitialList(worktree.id)
    await this.requestRendererGraphResync(worktree.id)
    return this.getMobileSessionTabsForWorktree(worktree.id, clientNavigationId)
  }

  // Worktrees whose forced resync has succeeded (reply received) — never resynced again.
  protected forceResyncedMobileWorktrees = new Set<string>()
  // Worktrees with a resync round trip in flight — blocks a concurrent duplicate.
  protected resyncInFlightMobileWorktrees = new Set<string>()
  // Failed resync attempts per worktree; caps retries so a never-replying renderer
  // can't cost a 10s round trip on every list/close/mutation forever.
  protected resyncAttemptsByMobileWorktree = new Map<string, number>()

  // Why: the initial-list reconcile above only recovers client-hosted browser
  // pages (page registry) — it cannot see renderer-owned tabs the desktop opened
  // under an authoritative window, because the renderer only publishes a
  // worktree's snapshot when it changed. A worktree the phone enters for the
  // first time hasn't "changed" since the last sync, so its renderer-owned
  // browser tabs never reach mobileSessionTabsByWorktree and the phone shows
  // none. Ask the renderer to force a full republish of just this worktree
  // (fingerprint reset → treated as changed) and wait for its round-trip reply;
  // by the time it lands the renderer's syncWindowGraph has already committed
  // the worktree's full snapshot into the stored map, so the caller reads the
  // desktop's already-open tabs on the very first list. Headless / no-window
  // runtimes have no renderer to ask (getAvailableAuthoritativeWindow → null) so
  // this no-ops; a timeout or send failure is swallowed so the list never fails.
  protected async requestRendererGraphResync(worktreeId: string): Promise<void> {
    // Why: listMobileSessionTabs backs session.tabs.list/subscribe/unsubscribe and
    // the close/mutation RPCs, and the mobile client polls list — so resyncing
    // unconditionally would force a full renderer republish + round trip (up to the
    // 10s wait) on every one of those. The missing-pages gap only exists until a
    // forced resync has succeeded, so resync at most once per worktree per session.
    // NB: do NOT gate on acceptedRendererMobileSnapshotByWorktree — main can hold an
    // accepted snapshot that carries terminals but no browser pages (the renderer
    // published the worktree before/without them), so that gate skips the resync
    // exactly when the desktop's pages are missing (verified on-device).
    if (this.forceResyncedMobileWorktrees.has(worktreeId)) {
      return
    }
    // Why: block a concurrent list/subscribe/poll for the same worktree from
    // launching a second republish, but do NOT mark it done here — only a received
    // reply marks it (below), so a timed-out or failed first attempt (e.g. the
    // renderer bridge isn't registered yet) stays retryable on the next list,
    // symmetric with the no-window path.
    if (this.resyncInFlightMobileWorktrees.has(worktreeId)) {
      return
    }
    // Why: with retry-on-timeout, a renderer that never replies would otherwise
    // start a fresh 10s round trip on every list/subscribe/close/mutation. Cap the
    // no-reply attempts so we stop after a few and fall back to the create-a-tab
    // path, instead of paying the timeout repeatedly.
    if ((this.resyncAttemptsByMobileWorktree.get(worktreeId) ?? 0) >= MAX_MOBILE_RESYNC_ATTEMPTS) {
      return
    }
    const win = this.getAvailableAuthoritativeWindow()
    if (!win || win.isDestroyed()) {
      return
    }
    this.resyncInFlightMobileWorktrees.add(worktreeId)
    this.resyncAttemptsByMobileWorktree.set(
      worktreeId,
      (this.resyncAttemptsByMobileWorktree.get(worktreeId) ?? 0) + 1
    )
    // Why: the renderer re-sends this worktree at its current (possibly unchanged)
    // snapshot version, so main's same-version dedup would drop the resend even
    // though its content differs (e.g. desktop browser pages now present). Flag the
    // worktree so the next publication bypasses that dedup.
    this.forceAcceptNextRendererPublish.add(worktreeId)
    const requestId = randomUUID()
    try {
      const replied = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          ipcMain.removeListener('browser:requestGraphResyncReply', handler)
          resolve(false)
        }, 10_000)

        const handler = (
          event: Electron.IpcMainEvent,
          reply: { requestId: string; ok?: boolean }
        ): void => {
          if (event.sender !== win.webContents || reply.requestId !== requestId) {
            return
          }
          clearTimeout(timer)
          ipcMain.removeListener('browser:requestGraphResyncReply', handler)
          // Why: the renderer replies even when the republish failed to reach main;
          // treat only an explicit ok as success so a failed publish stays retryable.
          resolve(reply.ok === true)
        }
        ipcMain.on('browser:requestGraphResyncReply', handler)
        try {
          win.webContents.send('browser:requestGraphResync', { requestId, worktreeId })
        } catch {
          clearTimeout(timer)
          ipcMain.removeListener('browser:requestGraphResyncReply', handler)
          resolve(false)
        }
      })
      if (replied) {
        this.forceResyncedMobileWorktrees.add(worktreeId)
        this.resyncAttemptsByMobileWorktree.delete(worktreeId)
      }
    } finally {
      this.resyncInFlightMobileWorktrees.delete(worktreeId)
      // Why: on success the forced publish already consumed this flag in
      // syncMobileSessionTabs (which runs before the reply resolves), so this is a
      // no-op; on a send failure / timeout / ok:false no publish consumed it, and a
      // lingering flag would wrongly bypass the same-version/stale-frame dedup for an
      // unrelated later publication — clear it so only the requested resync benefits.
      this.forceAcceptNextRendererPublish.delete(worktreeId)
    }
  }

  // Why: the initial list path only hydrates terminals; browser reconcile is
  // skipped for attached-window (renderer-owned) worktrees, so the stored
  // snapshot may lack pages the desktop already has open — the phone then shows
  // none until a fresh tab is created and the renderer republishes. Pull the
  // live renderer-owned pages from the page registry (via
  // buildHeadlessMobileSessionBrowserTabs → listPages) into the stored snapshot
  // now, so the very first list carries them. No-op when the snapshot is absent
  // or already matches (reconcile bails via headlessBrowserTabsUnchanged).
  protected reconcileMobileSessionBrowserTabsOnInitialList(worktreeId: string): void {
    const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!existing) {
      return
    }
    this.reconcileHeadlessMobileSessionBrowserTabs(worktreeId, existing)
  }

  async listAllMobileSessionTabs(
    clientNavigationId?: string
  ): Promise<RuntimeMobileSessionTabsResult[]> {
    return (await this.listAllMobileSessionTabsWithChangeSequence(clientNavigationId)).snapshots
  }

  async listAllMobileSessionTabsWithChangeSequence(clientNavigationId?: string): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    changeSequence: number
  }> {
    const inventory = await this.collectAllMobileSessionTabs(clientNavigationId)
    return { snapshots: inventory.snapshots, changeSequence: inventory.changeSequence }
  }

  protected async collectAllMobileSessionTabs(clientNavigationId?: string): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    ptyInventory: PtyControllerInventory | null
    changeSequence: number
  }> {
    for (const worktreeId of this.getKnownWorkspaceSessionWorktreeIds()) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
    const ptyInventory = await this.refreshMobileSessionPtyInventory()
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(null)
    const snapshots = [...this.mobileSessionTabsByWorktree.values()].map((snapshot) =>
      this.projectMobileSessionTabsForClient(
        this.toMobileSessionTabsResult(snapshot),
        clientNavigationId
      )
    )
    return { snapshots, ptyInventory, changeSequence: this.mobileSessionTabsChangeSequence }
  }

  async listAllMobileSessionTabsInventory(
    clientNavigationId?: string,
    signal?: AbortSignal
  ): Promise<{ snapshots: RuntimeMobileSessionTabsResult[]; authoritative?: true }> {
    const { snapshots, authoritative } =
      await this.listAllMobileSessionTabsInventoryWithChangeSequence(clientNavigationId, signal)
    return { snapshots, ...(authoritative ? { authoritative } : {}) }
  }

  async listAllMobileSessionTabsInventoryWithChangeSequence(
    clientNavigationId?: string,
    signal?: AbortSignal
  ): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    authoritative?: true
    changeSequence: number
  }> {
    this.assertSessionTabsInventoryRequestActive(signal)
    const primedPublicationEpoch = this.getAuthoritativeSessionTabsInventoryEpoch()
    const primed = await this.collectAllMobileSessionTabs(clientNavigationId)
    this.assertSessionTabsInventoryRequestActive(signal)
    if (
      primedPublicationEpoch !== null &&
      this.getAuthoritativeSessionTabsInventoryEpoch() === primedPublicationEpoch
    ) {
      return await this.settleSessionTabsInventory(primed, clientNavigationId, signal)
    }
    while (true) {
      const publicationEpoch = this.getAuthoritativeSessionTabsInventoryEpoch()
      if (publicationEpoch === null) {
        await this.waitForSessionTabsInventoryPublication(signal)
        continue
      }
      const inventory = await this.collectAllMobileSessionTabs(clientNavigationId)
      this.assertSessionTabsInventoryRequestActive(signal)
      if (this.getAuthoritativeSessionTabsInventoryEpoch() === publicationEpoch) {
        return await this.settleSessionTabsInventory(inventory, clientNavigationId, signal)
      }
    }
  }

  protected async settleSessionTabsInventory(
    inventory: {
      snapshots: RuntimeMobileSessionTabsResult[]
      ptyInventory: PtyControllerInventory | null
      changeSequence: number
    },
    clientNavigationId?: string,
    signal?: AbortSignal
  ): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    authoritative?: true
    changeSequence: number
  }> {
    if (this.isCompleteSessionTabsPtyCensus(inventory.ptyInventory)) {
      return {
        snapshots: inventory.snapshots,
        authoritative: true,
        changeSequence: inventory.changeSequence
      }
    }
    const retried = await this.collectAllMobileSessionTabs(clientNavigationId)
    this.assertSessionTabsInventoryRequestActive(signal)
    return { snapshots: retried.snapshots, changeSequence: retried.changeSequence }
  }

  supportsAuthoritativeSessionTabsInventory(): boolean {
    return process.env.ORCA_E2E_DISABLE_AUTHORITATIVE_SESSION_TABS_INVENTORY !== '1'
  }

  protected assertSessionTabsInventoryRequestActive(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error('client_disconnected')
    }
  }

  protected isCompleteSessionTabsPtyCensus(inventory: PtyControllerInventory | null): boolean {
    if (!inventory) {
      return false
    }
    const knownHostIds = this.listKnownExecutionHostIds(inventory.queriedHostIds)
    return ![...knownHostIds].some((hostId) => {
      const parsed = parseExecutionHostId(hostId)
      return parsed?.kind !== 'runtime' && !inventory.queriedHostIds.has(hostId)
    })
  }
}
