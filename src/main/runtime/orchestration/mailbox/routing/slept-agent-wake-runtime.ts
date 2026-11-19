import { mailWakeObligation } from '../../../../../shared/agent-session/lifecycle/mail-wake-obligation'
import { queueTerminalWorkspaceCommand } from '../../../workspaces/lifecycle/workspace-lifecycle-commands'
import { makePaneKey, parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitCondition
} from '../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { TerminalWaiter } from '../../../terminal/wait/terminal-waiter'
import { RuntimeSleptMailboxWakes } from './slept-mailbox-runtime'

// Covers a cold agent resume; a caller's own deadline overrides it.
const SLEPT_AGENT_WAKE_TIMEOUT_MS = 120_000
// Backstop for a bind no identity change reports; only while a wake is in flight.
const SLEPT_AGENT_WAKE_RECHECK_MS = 500

/** An Agent-slept pane answers orchestration as an idle agent: terminal acts wake it in place. */
export abstract class RuntimeSleptAgentWakes extends RuntimeSleptMailboxWakes {
  /** One wake per slept handle, held until its agent is idle, so every act arriving meanwhile joins it. */
  private readonly sleptAgentWakes = new Map<string, { paneKey: string; woken: Promise<void> }>()
  private readonly wokenHandleChecks = new Set<() => void>()
  private stopWatchingWokenHandles: (() => void) | null = null
  private wakeRecheck: ReturnType<typeof setInterval> | null = null
  private wakesInFlight = 0
  /** Exit waits begun before the sleep, carried to the woken process, with the leaf they slept in. */
  private readonly carriedExitWaits = new Map<TerminalWaiter, string>()

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
        if (error instanceof Error && error.message === 'terminal_handle_stale') {
          return { handle, condition, satisfied: true, status: 'exited' as const, exitCode: null }
        }
        throw error
      }
    )
  }

  /** An exit wait on the process Agent Sleep stopped follows the agent to its woken process. */
  protected carrySleptAgentExitWait(waiter: TerminalWaiter): boolean {
    const record = this.handles.get(waiter.handle)
    if (!record || !this.sleptAgentPaneForHandle(waiter.handle)) {
      return false
    }
    this.carriedExitWaits.set(waiter, this.getLeafKey(record.tabId, record.leafId))
    this.watchWokenHandles()
    return true
  }

  protected override onSleptLeafGraphSynced(): void {
    for (const check of this.wokenHandleChecks) {
      check()
    }
    for (const [waiter, leafKey] of this.carriedExitWaits) {
      const ptyId = this.wokenHandlePtyId(waiter.handle)
      if (!this.terminalWaiters.has(waiter)) {
        this.carriedExitWaits.delete(waiter)
      } else if (ptyId) {
        this.carriedExitWaits.delete(waiter)
        this.terminalWaiters.move(waiter, ptyId)
      } else if (this.sleptLeafClosed(leafKey)) {
        // Closing a slept pane ends its agent, as closing an idle one does.
        this.carriedExitWaits.delete(waiter)
        this.terminalWaiters.resolve(waiter, {
          handle: waiter.handle,
          condition: 'exit',
          satisfied: true,
          status: 'exited',
          exitCode: null
        })
      }
    }
    if (this.wokenHandleChecks.size === 0 && this.carriedExitWaits.size === 0) {
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
    // One backstop for all in-flight wakes.
    this.wakesInFlight += 1
    this.wakeRecheck ??= setInterval(
      () => this.onSleptLeafGraphSynced(),
      SLEPT_AGENT_WAKE_RECHECK_MS
    )
    try {
      await this.awaitWokenHandle(handle, deadline)
    } finally {
      this.wakesInFlight -= 1
      if (this.wakesInFlight === 0 && this.wakeRecheck) {
        clearInterval(this.wakeRecheck)
        this.wakeRecheck = null
      }
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

  /** A slept pane's leaf left a settled graph: the pane was closed. */
  private sleptLeafClosed(leafKey: string | null): boolean {
    return leafKey !== null && this.graphStatus !== 'reloading' && !this.leaves.has(leafKey)
  }

  /** Resolves once the handle names a connected process again: graph sync binds it after the spawn. */
  private awaitWokenHandle(handle: string, deadline: number, signal?: AbortSignal): Promise<void> {
    const record = this.handles.get(handle)
    const leafKey = record ? this.getLeafKey(record.tabId, record.leafId) : null
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
        } else if (this.sleptLeafClosed(leafKey)) {
          settle(new Error('terminal_handle_stale'))
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
    this.stopWatchingWokenHandles ??= this.crewChanges.subscribe(() =>
      this.onSleptLeafGraphSynced()
    )
  }
}

function joinWithin(
  woken: Promise<void>,
  bounds: { signal?: AbortSignal; timeoutMs?: number }
): Promise<void> {
  const { signal, timeoutMs } = bounds
  if (!signal && !(timeoutMs && timeoutMs > 0)) {
    return woken
  }
  return new Promise((resolve, reject) => {
    const settle = (error?: unknown): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error === undefined) {
        resolve()
      } else {
        reject(error)
      }
    }
    const onAbort = (): void => settle(signal?.reason ?? new Error('request_aborted'))
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => settle(new Error('timeout')), timeoutMs)
        : undefined
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    woken.then(() => settle(), settle)
  })
}
