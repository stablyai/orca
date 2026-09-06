// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRestoreLivePairedRendererSessionOwnedMobileTerminals } from './orca-runtime-restore-live-paired-renderer-session-owned-mobile-terminals'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import {
  isDurableSleepingCapture,
  mayBackgroundWakeSleepingAgentSession,
  type SleepingAgentSessionRecord
} from '../../shared/agent-session-resume'
import {
  isInboundMessageTabMount,
  type TerminalTabMountIntent
} from '../../shared/terminal-tab-mount-intent'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import { findSleepingAgentSessionRecord } from './sleeping-pane-record-lookup'
import { resolveSleepingPaneWakeTarget } from './orchestration/sleeping-pane-wake-target'
import { SleepingPaneWakeScheduler } from './orchestration/sleeping-pane-wake-scheduler'

export class OrcaRuntimeWithWaitForLeafPtyId extends OrcaRuntimeWithRestoreLivePairedRendererSessionOwnedMobileTerminals {
  // Why: mobile may subscribe before the PTY spawns; wait for it so subscribe proceeds with phone-fit instead of a bare scrollback+end.
  waitForLeafPtyId(handle: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<string> {
    const leaf = this.resolveLeafForHandle(handle)
    if (leaf?.ptyId) {
      return Promise.resolve(leaf.ptyId)
    }

    // Why: ptyId null→real invalidates the old handle; capture tabId+leafId now for direct leaf lookup afterward.
    const record = this.handles.get(handle)
    const savedTabId = record?.tabId ?? null
    const savedLeafId = record?.leafId ?? null

    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let check: () => void = () => {}
      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
        signal?.removeEventListener('abort', onAbort)
      }
      const finish = (ptyId: string): void => {
        cleanup()
        resolve(ptyId)
      }
      const fail = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const onAbort = (): void => {
        fail(new Error('request_aborted'))
      }
      if (signal?.aborted) {
        reject(new Error('request_aborted'))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        fail(new Error('Timed out waiting for PTY to spawn'))
      }, timeoutMs)

      check = (): void => {
        // Try the handle first (works if handle wasn't invalidated yet)
        let ptyId = this.resolveLeafForHandle(handle)?.ptyId
        // Why: ptyId null→real invalidates the old handle; fall back to direct leaf lookup by saved coordinates.
        if (!ptyId && savedTabId && savedLeafId) {
          const directLeaf = this.leaves.get(this.getLeafKey(savedTabId, savedLeafId))
          ptyId = directLeaf?.ptyId ?? null
        }
        if (ptyId) {
          finish(ptyId)
        }
      }
      this.graphSyncCallbacks.push(check)
      check()
    })
  }

  // Why: never-mounted tabs have no PTY or snapshot; synthetic handles need the ptyId to mount the exact owning tab.
  requestRendererTerminalTabMount(handle: string, intent?: TerminalTabMountIntent): boolean {
    const record = this.handles.get(handle)
    if (!record?.worktreeId) {
      return false
    }
    const tabId = record.tabId.startsWith('pty:') ? undefined : record.tabId
    return this.requestRendererTerminalTabMountForPane({
      worktreeId: record.worktreeId,
      tabId,
      ptyId: record.ptyId ?? undefined,
      // Why: synthetic pty-form handles carry no real pane identity, and
      // makePaneKey rejects their ids outright.
      paneKey:
        tabId && isTerminalLeafId(record.leafId) ? makePaneKey(tabId, record.leafId) : undefined,
      intent
    })
  }

  // Why: a slept pane has no handle record left, so mail-driven wakes address the
  // tab the sleeping record names instead of a handle that no longer resolves.
  requestRendererTerminalTabMountForPane(args: {
    worktreeId: string
    tabId?: string
    ptyId?: string
    paneKey?: string
    intent?: TerminalTabMountIntent
  }): boolean {
    if (!args.worktreeId || (!args.tabId && !args.ptyId)) {
      return false
    }
    // Why: webContents.send can accept the event while a renderer reload has no
    // graph/listener to consume it; report failure so graph-ready redrives mail wakes.
    if (isInboundMessageTabMount(args.intent) && this.graphStatus !== 'ready') {
      return false
    }
    // Why: opening a tab is the documented wake gesture for a pane the user slept
    // (#11598), so only an inbound message may be refused for one.
    if (
      isInboundMessageTabMount(args.intent) &&
      args.paneKey &&
      !this.mayBackgroundWakeSleepingPane(args.paneKey)
    ) {
      return false
    }
    try {
      this.getAuthoritativeWindow().webContents.send('terminal:requestTabMount', {
        worktreeId: args.worktreeId,
        ...(args.tabId ? { tabId: args.tabId } : {}),
        ...(args.ptyId ? { ptyId: args.ptyId } : {}),
        ...(args.paneKey ? { paneKey: args.paneKey } : {}),
        ...(args.intent ? { intent: args.intent } : {})
      })
      return true
    } catch {
      // No authoritative window (shutdown/headless): subscribe keeps its empty-snapshot fallback.
      return false
    }
  }

  findSleepingAgentRecordForPane(paneKey: string): SleepingAgentSessionRecord | undefined {
    return findSleepingAgentSessionRecord(this.workspaceSessions.listSessions(), paneKey)
  }

  /**
   * The pane behind a handle whose process is gone but whose resume record can
   * bring it back, plus whether inbound mail may wake it on its own. Lets a
   * sender tell "asleep, will read this later" from "gone, nothing to talk to".
   */
  getResumableSleptRecipientPane(handle: string): { paneKey: string; autoWakes: boolean } | null {
    if (this.getLiveTerminalPaneKey(handle)) {
      return null
    }
    const paneKey = this.getTerminalPaneKey(handle)
    const record = paneKey ? this.findSleepingAgentRecordForPane(paneKey) : undefined
    if (!paneKey || !record || !isDurableSleepingCapture(record)) {
      return null
    }
    return { paneKey, autoWakes: mayBackgroundWakeSleepingAgentSession(record) }
  }

  protected mayBackgroundWakeSleepingPane(paneKey: string): boolean {
    const record = this.findSleepingAgentRecordForPane(paneKey)
    return Boolean(record && mayBackgroundWakeSleepingAgentSession(record))
  }

  protected readonly sleepingPaneWakes = new SleepingPaneWakeScheduler({
    wake: (request) =>
      !this.mayBackgroundWakeSleepingPane(request.paneKey) ||
      this.requestRendererTerminalTabMountForPane({ ...request, intent: 'inbound-message' })
  })

  protected retrySleepingPaneWakesWhenGraphReady(windowId: number): void {
    if (windowId === this.authoritativeWindowId && this.graphStatus === 'ready') {
      this.sleepingPaneWakes.retryPending()
    }
  }

  /**
   * Mail landed for a mailbox whose pane has no process. The message arriving IS
   * the evidence the pane is owed something, so every type wakes — no allowlist.
   */
  requestSleepingRecipientWake(mailboxHandle: string): void {
    const db = this._orchestrationDb
    if (!db) {
      return
    }
    // Why the mail check: delivery also runs from sweeps that visit empty
    // mailboxes — pty retirement redrives and restored-mailbox repoints fire
    // right when hibernation kills the pane. Without proof someone is owed
    // mail, the kill itself would schedule the wake that undoes it (observed
    // live: pane slept and self-woke two seconds later). Unread is the
    // evidence; delivered-but-unread still counts because a pointer staged to
    // a dying pane is exactly the mail a wake must rescue. An answerless query
    // wakes anyway: "could not look" must not read as "mailbox empty".
    const unreadTypes = db.getUnreadDirectMessageTypes?.(mailboxHandle)
    if (unreadTypes !== undefined && unreadTypes.length === 0) {
      return
    }
    const resolution = resolveSleepingPaneWakeTarget(mailboxHandle, {
      getRunCoordinatorPaneKey: (runId) => db.getRun?.(runId)?.coordinator_pane_key ?? undefined,
      getDispatchAssigneePaneKey: (dispatchId) =>
        db.getDispatchContextById?.(dispatchId)?.assignee_pane_key ??
        db.getRemoteDispatchAttachment?.(dispatchId)?.pane_key ??
        undefined,
      getPaneKeyForHandle: (handle) => this.getTerminalPaneKey(handle),
      getSleepingRecord: (paneKey) => this.findSleepingAgentRecordForPane(paneKey)
    })
    if (resolution.ok) {
      this.sleepingPaneWakes.request(resolution.request)
    }
  }

  getRendererTerminalSerializerGeneration(ptyId: string): number {
    return this.ptyController?.getRendererSerializerGeneration?.(ptyId) ?? 0
  }

  getRendererTerminalSerializerGenerationForHandle(handle: string): number {
    const ptyId = this.handles.get(handle)?.ptyId
    return ptyId ? this.getRendererTerminalSerializerGeneration(ptyId) : 0
  }

  replaceHeadlessTerminalFromRendererSnapshotForRecovery(
    ptyId: string,
    snapshot: {
      data: string
      cols: number
      rows: number
      cwd?: string | null
      oscLinks?: TerminalOscLinkRange[]
    },
    trailingOutput: { data: string; seq: number }[] = []
  ): void {
    if (!snapshot.data) {
      return
    }
    // Why: a redraw byte can create a suffix-only model before the renderer settles; replace it with the exact snapshot already sent mobile.
    this.providerSnapshotPreferredPtys.add(ptyId)
    this.disposeHeadlessTerminal(ptyId)
    this.seedHeadlessTerminal(
      ptyId,
      snapshot.data,
      { cols: snapshot.cols, rows: snapshot.rows },
      { cwd: snapshot.cwd, oscLinks: snapshot.oscLinks }
    )
    for (const chunk of trailingOutput) {
      this.trackHeadlessTerminalData(ptyId, chunk.data, chunk.seq)
    }
    // The seed's write chain owns subsequent live bytes; suppress on-data hydration from replacing this known-good seed.
    this.headlessHydrationState.set(ptyId, 'done')
  }

  waitForRendererTerminalSerializer(
    ptyId: string,
    afterGeneration: number,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    return (
      this.ptyController?.waitForRendererSerializer?.(ptyId, afterGeneration, timeoutMs, signal) ??
      Promise.resolve(false)
    )
  }

  // Why: a leaf exists before its PTY spawns; a handle issued while ptyId is null gets invalidated on the next sync, so wait for a connected PTY.
  protected countLeavesInTab(tabId: string): number {
    let count = 0
    for (const leaf of this.leaves.values()) {
      if (leaf.tabId === tabId) {
        count++
      }
    }
    return count
  }

  protected resolveHandleForTab(tabId: string): string | null {
    for (const leaf of this.leaves.values()) {
      if (leaf.tabId === tabId && leaf.ptyId !== null) {
        return this.issueHandle(leaf)
      }
    }
    return null
  }
}
