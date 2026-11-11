import { PaneOwnerContentionError } from '../../../ipc/pty/pane/pane-spawn-operation'
import {
  makePaneSpawnReservationKey,
  paneSpawnReservationsByOwnerKey,
  type PaneSpawnReservation
} from '../../../ipc/pty/pane/spawn-reservation'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { createRetainedTerminalAttempt } from './retained-terminal-attempt'
import { OrcaRuntimeWithPreparedLayoutPaneReplacement } from './prepared-layout-pane-replacement'
import { PaneStartStatuses } from '../surface/pane-start-statuses'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { RetainedTerminalSessionIndex } from '../surface/retained-terminal-session-index'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RetainedTerminalStart } from '../../../../shared/workspace-layout/retained-terminal-start'
import type { RetainedTerminalDestination } from '../../../../shared/workspace-layout/retained-terminal-destination'
import { revealRetainedTerminalStart } from './terminal-create-reveal'

/** Current admitted starts survive renderer delivery loss until binding or explicit removal. */
export abstract class OrcaRuntimeWithRetainedTerminalStarts extends OrcaRuntimeWithPreparedLayoutPaneReplacement {
  protected abstract markPaneLiveTitlesDirty(): void
  private readonly retainedSessionIndex = new RetainedTerminalSessionIndex((hostId) =>
    this.store?.getWorkspaceSession?.(hostId)
  )
  private readonly retainedSessionRevisions = new Map<
    ExecutionHostId,
    ReturnType<RetainedTerminalSessionIndex['revision']>
  >()
  private detachRetainedSessionWrites: (() => void) | undefined

  protected readonly paneStartStatuses = new PaneStartStatuses(
    (_paneKey, fact) => {
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        this.markPaneLiveTitlesDirty()
      }
      for (const hostId of this.retainedSessionRevisions.keys()) {
        if (!this.paneStartStatuses.hasRetainedHost(hostId)) {
          this.retainedSessionRevisions.delete(hostId)
          this.retainedSessionIndex.forget(hostId)
        }
      }
      if (fact.retainedTerminalStart) {
        const hostId = fact.retainedTerminalStart.executionHostId
        if (this.paneStartStatuses.hasRetainedHost(hostId)) {
          if (!this.retainedSessionRevisions.has(hostId)) {
            this.retainedSessionRevisions.set(hostId, this.retainedSessionIndex.revision(hostId))
          }
          this.detachRetainedSessionWrites ??= this.store?.onWorkspaceSessionWritten?.((host) =>
            this.retireChangedRetainedStarts(host)
          )
        }
      }
      if (this.retainedSessionRevisions.size === 0) {
        this.detachRetainedSessionWrites?.()
        this.detachRetainedSessionWrites = undefined
      }
      const worktreeId = fact.retainedTerminalStart?.worktreeId
      const snapshot = worktreeId ? this.mobileSessionTabsByWorktree.get(worktreeId) : undefined
      if (snapshot) {
        snapshot.snapshotVersion += 1
        this.scheduleMobileSessionTabsChanged(snapshot.worktree)
      }
    },
    {
      acceptsUnqualified: ORCA_LAYOUT_OWNER_IS_MAIN,
      bindingOf: (start) => this.retainedSessionIndex.binding(start)
    }
  )

  private retireChangedRetainedStarts(host: ExecutionHostId | null): void {
    const hosts = host === null ? this.paneStartStatuses.retainedHosts() : [host]
    for (const hostId of hosts) {
      const previous = this.retainedSessionRevisions.get(hostId)
      if (!previous) {
        continue
      }
      const revision = this.retainedSessionIndex.revision(hostId)
      if (previous === revision) {
        continue
      }
      this.retainedSessionRevisions.set(hostId, revision)
      for (const paneKey of this.paneStartStatuses.retainedKeys(hostId)) {
        const fact = this.paneStartStatuses.peek(paneKey)
        if (fact && !this.retainedSessionIndex.isCurrent(fact, revision)) {
          this.paneStartStatuses.clear(paneKey, fact)
        }
      }
    }
  }

  /** Committed runtime teardown owns the Store listener and its transient facts. */
  disposeRetainedTerminalStarts(): void {
    this.detachRetainedSessionWrites?.()
    this.detachRetainedSessionWrites = undefined
    for (const [paneKey, { fact }] of this.paneStartStatuses.entries()) {
      this.paneStartStatuses.clear(paneKey, fact)
    }
    this.retainedSessionRevisions.clear()
    this.retainedSessionIndex.clear()
  }

  getRetainedTerminalStart(
    worktreeId: string,
    tabId: string,
    leafId: string
  ): RetainedTerminalStart | null {
    const paneKey = `${tabId}:${leafId}`
    const fact = this.paneStartStatuses.peek(paneKey)
    const start = fact?.retainedTerminalStart
    if (!start || start.worktreeId !== worktreeId) {
      return null
    }
    if (!this.retainedSessionIndex.isCurrent(fact)) {
      this.paneStartStatuses.clear(paneKey, fact)
      return null
    }
    return start
  }

  getRetainedTerminalStartupDestinations(): RetainedTerminalDestination[] {
    const destinations: RetainedTerminalDestination[] = []
    for (const [, { fact }] of this.paneStartStatuses.entries()) {
      const candidate = fact.retainedTerminalStart
      if (!candidate) {
        continue
      }
      const start = this.getRetainedTerminalStart(
        candidate.worktreeId,
        candidate.tabId,
        candidate.leafId
      )
      if (!start) {
        continue
      }
      const session = this.store?.getWorkspaceSession?.(start.executionHostId)
      const tab = this.retainedSessionIndex.tab(
        start,
        this.retainedSessionIndex.revision(start.executionHostId)
      )
      const layout = session?.terminalLayoutsByTabId?.[start.tabId]
      if (tab && layout) {
        const group = session?.tabGroups?.[start.worktreeId]?.find((row) =>
          row.tabOrder.includes(tab.id)
        )
        destinations.push({
          start,
          tab,
          layout,
          ...(group ? { group } : {}),
          ...(session?.tabGroupLayouts?.[start.worktreeId]
            ? { groupLayout: session.tabGroupLayouts[start.worktreeId] }
            : {})
        })
      }
    }
    return destinations
  }

  beginRetainedTerminalAttempt(
    worktreeId: string,
    tabId: string,
    leafId: string,
    owner: { key: string; reservation: PaneSpawnReservation } | undefined
  ) {
    const previous = this.getRetainedTerminalStart(worktreeId, tabId, leafId)
    if (!previous) {
      return null
    }
    const paneKey = `${tabId}:${leafId}`
    const predecessor = this.paneStartStatuses.peek(paneKey)!
    const host = parseExecutionHostId(previous.executionHostId)
    if (
      predecessor.inFlightOperation ||
      !owner ||
      owner.key !==
        makePaneSpawnReservationKey(
          worktreeId,
          host?.kind === 'ssh' ? host.targetId : null,
          paneKey
        ) ||
      paneSpawnReservationsByOwnerKey.get(owner.key) !== owner.reservation
    ) {
      throw new PaneOwnerContentionError()
    }
    return createRetainedTerminalAttempt({
      previous,
      predecessor,
      paneKey,
      sink: this.paneStartStatuses,
      owner,
      currentStart: () => this.getRetainedTerminalStart(worktreeId, tabId, leafId),
      bindingOf: (start) => this.retainedSessionIndex.binding(start),
      generationOf: (start) =>
        this.store?.getPtyBindingGeneration?.(start.executionHostId, leafId) ?? 0,
      isCurrent: (fact) => this.retainedSessionIndex.isCurrent(fact),
      publish: (start) => {
        void revealRetainedTerminalStart({
          notifier: this.notifier,
          start,
          opts: { presentation: 'background' }
        }).catch((error: unknown) => console.warn('[terminal] start publication failed:', error))
      }
    })
  }

  protected publishRetainedTerminalDestination(start: RetainedTerminalStart): void {
    if (!this.getRetainedTerminalStart(start.worktreeId, start.tabId, start.leafId)) {
      return
    }
    const session = this.store?.getWorkspaceSession?.(start.executionHostId)
    const saved = session?.tabsByWorktree?.[start.worktreeId]?.find((tab) => tab.id === start.tabId)
    const layout = session?.terminalLayoutsByTabId?.[start.tabId]
    if (!saved || !layout) {
      return
    }
    const existing = this.mobileSessionTabsByWorktree.get(start.worktreeId)
    const id = `${start.tabId}::${start.leafId}`
    const tab = {
      type: 'terminal' as const,
      id,
      parentTabId: start.tabId,
      leafId: start.leafId,
      title: saved.title,
      customTitle: saved.customTitle,
      parentLayout: layout,
      startupCwd: saved.startupCwd,
      viewMode: saved.viewMode,
      isActive: false
    }
    const tabs = [...(existing?.tabs ?? []).filter((candidate) => candidate.id !== id), tab]
    const group = session?.tabGroups?.[start.worktreeId]?.find((row) =>
      row.tabOrder.includes(start.tabId)
    )
    this.storeMobileSessionSnapshot(start.worktreeId, {
      ...(existing ?? {
        worktree: start.worktreeId,
        publicationEpoch: `headless:${Date.now().toString(36)}`,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null
      }),
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
      tabs,
      ...(group
        ? {
            tabGroups: [...(existing?.tabGroups ?? []).filter((row) => row.id !== group.id), group]
          }
        : {}),
      ...(session?.tabGroupLayouts?.[start.worktreeId]
        ? { tabGroupLayout: session.tabGroupLayouts[start.worktreeId] }
        : {})
    })
    this.scheduleMobileSessionTabsChanged(start.worktreeId)
  }
}
