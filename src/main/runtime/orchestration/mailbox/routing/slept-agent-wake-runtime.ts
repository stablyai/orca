import { mailWakeObligation } from './mail-wake-obligation'
import { queueTerminalWorkspaceCommand } from '../../../workspaces/lifecycle/workspace-lifecycle-commands'
import { makePaneKey, parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitCondition
} from '../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { RuntimeSleptMailboxWakes } from './slept-mailbox-runtime'
import { joinWithin } from './slept-agent-wake-join'

// Covers a cold agent resume; a caller's own deadline overrides it.
const SLEPT_AGENT_WAKE_TIMEOUT_MS = 120_000
const SLEPT_PANE_CLOSED = 'slept_pane_closed'

/** An Agent-slept pane answers orchestration as an idle agent: terminal acts wake it in place. */
export abstract class RuntimeSleptAgentWakes extends RuntimeSleptMailboxWakes {
  /** One wake per slept handle, held until its agent is idle, so every act arriving meanwhile joins it. */
  private readonly sleptAgentWakes = new Map<string, { paneKey: string; woken: Promise<void> }>()
  private readonly wokenHandleChecks = new Set<() => void>()
  private stopWatchingWokenHandles: (() => void) | null = null
  private recheckingSleptWaits = false
  private sleptRecheckQueued = false

  /** The pane an Agent-slept handle names: parked with no process, and not under the user's own Sleep. */
  protected sleptAgentPaneForHandle(
    handle: string
  ): { paneKey: string; worktreeId: string } | null {
    const record = this.handles.get(handle)
    const leaf = record && this.leaves.get(this.getLeafKey(record.tabId, record.leafId))
    if (!record || !leaf || this.sleptLeafHandle(leaf) !== handle) {
      return null
    }
    const paneKey = makePaneKey(record.tabId, record.leafId)
    this.watchSleepingMail()
    return mailWakeObligation(this.sleepingMailRecord(paneKey)) === 'manual'
      ? null
      : { paneKey, worktreeId: record.worktreeId }
  }

  /** The handle of the slept agent in this pane, which takes input as an idle agent does; null when
   *  the pane runs a process, never slept, or sleeps under the user's own Sleep. */
  sleptAgentHandleForPane(paneKey: string | null | undefined): string | null {
    const pane = paneKey ? parsePaneKey(paneKey) : null
    const leaf = pane ? this.leaves.get(this.getLeafKey(pane.tabId, pane.leafId)) : undefined
    if (!leaf) {
      return null
    }
    const handle = this.sleptLeafHandle(leaf)
    return handle && this.sleptAgentPaneForHandle(handle) ? handle : null
  }

  /** A terminal act on a slept agent resumes it in place, once however many acts arrive, and settles
   *  when the agent is idle under the same handle. Null when the handle is neither slept nor waking. */
  wakeSleptAgentHandle(
    handle: string,
    bounds: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<string> | null {
    let wake = this.sleptAgentWakes.get(handle)
    if (!wake) {
      const pane = this.sleptAgentPaneForHandle(handle)
      if (!pane) {
        return null
      }
      const woken = this.wakeSleptPane(handle, pane).finally(() =>
        this.sleptAgentWakes.delete(handle)
      )
      wake = { paneKey: pane.paneKey, woken }
      this.sleptAgentWakes.set(handle, wake)
    }
    return joinWithin(wake.woken, bounds).then(() => handle)
  }

  /** A pane this runtime is waking keeps the resume custody its window stamped until the agent is idle. */
  protected override holdsSleptPaneWake(paneKey: string): boolean {
    for (const wake of this.sleptAgentWakes.values()) {
      if (wake.paneKey === paneKey) {
        return true
      }
    }
    return false
  }

  /** Agent Sleep never takes an agent owed orchestration mail or one a Dispatch is still handing work to. */
  assertAgentSleepAdmitted(ptyId: string): void {
    const terminal = this.getOrchestrationMailboxTerminal(ptyId)
    if (!terminal) {
      return
    }
    const db = this._orchestrationDb
    const handshake = terminal.paneKeys.some(
      (paneKey) => db?.getActiveDispatchForIdentity(terminal.handle, paneKey)?.status === 'pending'
    )
    if (handshake || this.orchestrationMailboxNotifications.hasDeliverableMail(terminal)) {
      throw new Error('orchestration_busy')
    }
  }

  /** A slept agent waits as an idle one: idle now, and no exit until a woken process exits. */
  protected waitForSleptAgent(
    handle: string,
    options: {
      condition?: RuntimeTerminalWaitCondition
      timeoutMs?: number
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeTerminalWait> | null {
    if (!this.sleptAgentPaneForHandle(handle)) {
      return null
    }
    const condition = options.condition ?? 'exit'
    if (condition === 'tui-idle') {
      return Promise.resolve({
        handle,
        condition,
        satisfied: true,
        status: 'running',
        exitCode: null
      })
    }
    const deadline =
      options.timeoutMs && options.timeoutMs > 0 ? Date.now() + options.timeoutMs : Infinity
    return this.awaitWokenHandle(handle, deadline, options.signal).then(
      () =>
        this.waitForTerminal(handle, {
          ...options,
          ...(deadline === Infinity ? {} : { timeoutMs: Math.max(1, deadline - Date.now()) })
        }),
      (error: unknown) => {
        // Closing a slept pane ends its agent, as closing an idle one does.
        if (error instanceof Error && error.message === SLEPT_PANE_CLOSED) {
          return { handle, condition, satisfied: true, status: 'exited' as const, exitCode: null }
        }
        throw error
      }
    )
  }

  protected override onSleptLeafGraphSynced(): void {
    // A check can restore a parked name, which notifies identity changes again.
    if (this.recheckingSleptWaits) {
      return
    }
    this.recheckingSleptWaits = true
    try {
      this.recheckSleptWaits()
    } finally {
      this.recheckingSleptWaits = false
    }
  }

  private recheckSleptWaits(): void {
    for (const check of this.wokenHandleChecks) {
      check()
    }
    if (this.wokenHandleChecks.size === 0) {
      this.stopWatchingWokenHandles?.()
      this.stopWatchingWokenHandles = null
    }
  }

  private async wakeSleptPane(
    handle: string,
    pane: { paneKey: string; worktreeId: string }
  ): Promise<void> {
    const deadline = Date.now() + SLEPT_AGENT_WAKE_TIMEOUT_MS
    await this.requestSleptPaneResume(pane)
    try {
      await this.awaitWokenHandle(handle, deadline, undefined, parsePaneKey(pane.paneKey)?.leafId)
    } catch (error) {
      throw error instanceof Error && error.message === SLEPT_PANE_CLOSED
        ? new Error('terminal_handle_stale')
        : error
    }
    // The wait controller directly: the main-owned starter would route back into this wake.
    const ready = await this.terminalWait.wait(handle, {
      condition: 'tui-idle',
      timeoutMs: Math.max(1, deadline - Date.now())
    })
    // Input written into a dialog the resume raised would answer it, not reach the agent.
    if (!ready.satisfied) {
      throw new Error('agent_wake_failed')
    }
  }

  private async requestSleptPaneResume(pane: {
    paneKey: string
    worktreeId: string
  }): Promise<void> {
    // A mail wake already holds this pane's resume; joining it never starts a second process.
    if (mailWakeObligation(this.sleepingMailRecord(pane.paneKey)) === 'retained') {
      return
    }
    const woke = await queueTerminalWorkspaceCommand(this, `id:${pane.worktreeId}`, {
      kind: 'wake',
      run: async () =>
        this.getPtyRecordForPaneKey(pane.paneKey)?.connected === true ||
        (await this.notifier?.resumeSleepingAgents?.(pane.worktreeId, pane.paneKey)) === true
    })
    if (!woke) {
      throw new Error('agent_wake_failed')
    }
  }

  /** The connected process a handle names; works for window panes, which own their handles. */
  private wokenHandlePtyId(handle: string): string | null {
    const ptyId = this.handles.get(handle)?.ptyId
    return ptyId && this.ptysById.get(ptyId)?.connected === true ? ptyId : null
  }

  /** Whether a slept handle's pane is still there: a move keeps its leaf id, a reload is not settled,
   *  and a window graph that went away leaves nothing to answer for it. */
  private sleptPaneState(handle: string, leafId: string | null): 'open' | 'closed' | 'lost' {
    if (leafId === null || this.graphStatus === 'reloading') {
      return 'open'
    }
    if (this.graphStatus !== 'ready') {
      return 'lost'
    }
    const record = this.handles.get(handle)
    if (record && this.leaves.has(this.getLeafKey(record.tabId, record.leafId))) {
      return 'open'
    }
    for (const leaf of this.leaves.values()) {
      if (leaf.leafId === leafId) {
        // A reload re-mints parked names lazily; another name in the pane means this one is gone.
        return this.sleptLeafHandle(leaf) === handle ? 'open' : 'lost'
      }
    }
    return 'closed'
  }

  /** Resolves once the handle names a connected process again: graph sync binds it after the spawn. */
  private awaitWokenHandle(
    handle: string,
    deadline: number,
    signal?: AbortSignal,
    paneLeafId?: string
  ): Promise<void> {
    const leafId = paneLeafId ?? this.handles.get(handle)?.leafId ?? null
    return new Promise((resolve, reject) => {
      const settle = (error?: unknown): void => {
        this.wokenHandleChecks.delete(check)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error === undefined) {
          resolve()
        } else {
          reject(error)
        }
      }
      const check = (): void => {
        if (this.wokenHandlePtyId(handle)) {
          settle()
        } else {
          const pane = this.sleptPaneState(handle, leafId)
          if (pane !== 'open') {
            settle(new Error(pane === 'closed' ? SLEPT_PANE_CLOSED : 'terminal_handle_stale'))
          }
        }
      }
      const onAbort = (): void => settle(signal?.reason ?? new Error('request_aborted'))
      const timer =
        deadline === Infinity
          ? undefined
          : setTimeout(() => settle(new Error('timeout')), Math.max(0, deadline - Date.now()))
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.wokenHandleChecks.add(check)
      this.watchWokenHandles()
      check()
    })
  }

  /** Identity changes (binds, connects) re-check pending wakes; unsubscribed once none are pending. */
  private watchWokenHandles(): void {
    // Deferred: identity notifies mid-sync, before the graph's leaves and handles agree.
    this.stopWatchingWokenHandles ??= this.crewChanges.subscribe(() => {
      if (!this.sleptRecheckQueued) {
        this.sleptRecheckQueued = true
        queueMicrotask(() => {
          this.sleptRecheckQueued = false
          this.onSleptLeafGraphSynced()
        })
      }
    })
  }
}
