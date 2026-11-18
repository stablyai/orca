import { mailWakeObligation } from '../../../../../shared/agent-session/lifecycle/mail-wake-obligation'
import { queueTerminalWorkspaceCommand } from '../../../workspaces/lifecycle/workspace-lifecycle-commands'
import { makePaneKey, parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitCondition
} from '../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { RuntimeSleptMailboxWakes } from './slept-mailbox-runtime'

// Covers a cold agent resume; a caller's own deadline overrides it.
const SLEPT_AGENT_WAKE_TIMEOUT_MS = 120_000
const SLEPT_AGENT_WAKE_POLL_MS = 100

/** An Agent-slept pane answers orchestration as an idle agent: terminal acts wake it in place. */
export abstract class RuntimeSleptAgentWakes extends RuntimeSleptMailboxWakes {
  private readonly sleptPaneResumes = new Map<string, Promise<void>>()

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

  /** A terminal act on a slept agent resumes it in place, once however many acts arrive, then waits
   *  until the agent is idle in its new process under the same handle. Null when the handle isn't slept. */
  wakeSleptAgentHandle(
    handle: string,
    bounds: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<string> | null {
    const pane = this.sleptAgentPaneForHandle(handle)
    if (!pane) {
      return null
    }
    // One wake per pane, held until its process is live so no later act starts a second resume.
    let woken = this.sleptPaneResumes.get(pane.paneKey)
    if (!woken) {
      const paneDeadline = Date.now() + SLEPT_AGENT_WAKE_TIMEOUT_MS
      woken = this.requestSleptPaneResume(pane)
        .then(() => this.awaitWokenHandle(handle, paneDeadline))
        .finally(() => this.sleptPaneResumes.delete(pane.paneKey))
      this.sleptPaneResumes.set(pane.paneKey, woken)
    }
    const deadline =
      Date.now() +
      (bounds.timeoutMs && bounds.timeoutMs > 0 ? bounds.timeoutMs : SLEPT_AGENT_WAKE_TIMEOUT_MS)
    return Promise.race([woken, this.awaitWokenHandle(handle, deadline, bounds.signal)]).then(
      async () => {
        await this.waitForTerminal(handle, {
          condition: 'tui-idle',
          timeoutMs: Math.max(1, deadline - Date.now()),
          ...(bounds.signal ? { signal: bounds.signal } : {})
        })
        return handle
      }
    )
  }

  /** A pane this runtime is waking keeps the resume custody its window stamped until the process is live. */
  protected override holdsSleptPaneWake(paneKey: string): boolean {
    return this.sleptPaneResumes.has(paneKey)
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
    return this.awaitWokenHandle(handle, deadline, options.signal).then(() =>
      this.waitForTerminal(handle, {
        ...options,
        ...(deadline === Infinity ? {} : { timeoutMs: Math.max(1, deadline - Date.now()) })
      })
    )
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

  /** Resolves once the handle names a connected process again; graph sync binds it after the spawn. */
  private async awaitWokenHandle(
    handle: string,
    deadline: number,
    signal?: AbortSignal
  ): Promise<void> {
    while (this.getLivePtyForHandle(handle)?.pty.connected !== true) {
      signal?.throwIfAborted()
      if (Date.now() >= deadline) {
        throw new Error('timeout')
      }
      if (!this.handles.has(handle)) {
        throw new Error('terminal_handle_stale')
      }
      await new Promise((resolve) => setTimeout(resolve, SLEPT_AGENT_WAKE_POLL_MS))
    }
  }
}
