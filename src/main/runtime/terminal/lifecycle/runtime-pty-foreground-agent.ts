import { recognizeAgentProcess } from '../../../../shared/agent-status/process/agent-process-recognition'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { withTimeoutResult } from '../../../../shared/concurrency/promise-timeout-fallback'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from '../wait/terminal-interactive-probe-budget'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type {
  PtyForegroundAgentRefresh,
  PtyForegroundProcessRead,
  PtyForegroundProcessReadEntry
} from './pty-foreground-observation-state'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

type Dependencies = {
  getController(): RuntimePtyController | null
  getPty(ptyId: string): RuntimePtyWorktreeRecord | null
  touchSnapshot(ptyId: string): void
  finishDelayedSnapshot(ptyId: string, changed: boolean): void
  /** Main's attach of a surviving session, while in flight; it can restore the launch's agent. */
  pendingAttach(ptyId: string): Promise<unknown> | undefined
}

const NATIVE_CLAUDE_VERSION_NAME = /^\d+\.\d+\.\d+$/

export class RuntimePtyForegroundAgent {
  private readonly refreshes = new Map<string, PtyForegroundAgentRefresh>()
  private readonly reads = new Map<string, PtyForegroundProcessReadEntry>()
  private readonly delayedTitles = new Map<string, number>()
  private readonly identifies = new Map<string, Promise<TerminalAgent | null>>()
  // A scan's recognized agent for a version name holds while that name stays in the foreground.
  private readonly confirmedByPtyId = new Map<
    string,
    { foregroundName: string; agent: TerminalAgent }
  >()
  // Replaced when a read or forget() supersedes the PTY's foreground, so an older scan cannot write.
  private readonly foregroundEpochs = new Map<string, object>()

  constructor(private readonly deps: Dependencies) {}

  read(ptyId: string, afterTitle = 0): Promise<PtyForegroundProcessRead> | null {
    const controller = this.deps.getController()
    if (!controller) {
      return null
    }
    const pending = this.reads.get(ptyId)
    if (pending?.controller === controller && pending.startedAfterTitleObservation >= afterTitle) {
      return pending.promise
    }
    if (pending?.controller === controller) {
      return pending.promise.then(
        () => this.read(ptyId, afterTitle) ?? { controller, process: null, available: false }
      )
    }
    const unavailable: PtyForegroundProcessRead = { controller, process: null, available: false }
    let processRead: Promise<string | null>
    try {
      processRead = Promise.resolve(controller.getForegroundProcess(ptyId))
    } catch {
      const entry: PtyForegroundProcessReadEntry = {
        controller,
        startedAfterTitleObservation: afterTitle,
        promise: Promise.resolve(unavailable)
      }
      entry.promise = entry.promise.finally(() => this.deleteRead(ptyId, entry))
      this.reads.set(ptyId, entry)
      return entry.promise
    }
    let entry: PtyForegroundProcessReadEntry
    const promise = processRead
      .then((process) => ({ controller, process, available: true }))
      .catch(() => unavailable)
      .finally(() => this.deleteRead(ptyId, entry))
    entry = { controller, startedAfterTitleObservation: afterTitle, promise }
    this.reads.set(ptyId, entry)
    return entry.promise
  }

  refresh(ptyId: string, afterTitle = 0): Promise<boolean> {
    const pending = this.refreshes.get(ptyId)
    if (pending) {
      pending.requestedAfterTitleObservation = Math.max(
        pending.requestedAfterTitleObservation,
        afterTitle
      )
      return pending.promise
    }
    const entry: PtyForegroundAgentRefresh = {
      promise: Promise.resolve(false),
      startedAfterTitleObservation: afterTitle,
      requestedAfterTitleObservation: afterTitle
    }
    entry.promise = (async () => {
      let changed = false
      // A title after this load started can name a newer foreground, even when this load changed it.
      do {
        entry.startedAfterTitleObservation = entry.requestedAfterTitleObservation
        changed = (await this.load(ptyId, entry.startedAfterTitleObservation)) || changed
      } while (entry.requestedAfterTitleObservation > entry.startedAfterTitleObservation)
      return changed
    })().finally(() => {
      if (this.refreshes.get(ptyId) === entry) {
        this.refreshes.delete(ptyId)
      }
    })
    this.refreshes.set(ptyId, entry)
    return entry.promise
  }

  /**
   * Null when launch, foreground, or command evidence owns the pane, or `isCandidate` declines; resolves undefined only on timeout.
   * Not stored on the pty: a dialog declined before any title would leave no title transition to clear it.
   */
  identifyUnowned(
    ptyId: string,
    isCandidate: () => boolean
  ): Promise<TerminalAgent | null | undefined> | null {
    const pty = this.deps.getPty(ptyId)
    if (
      !pty ||
      (pty.launchAgent ?? pty.foregroundAgent ?? pty.launchCommandAgent) ||
      !isCandidate()
    ) {
      return null
    }
    let pending = this.identifies.get(ptyId)
    if (!pending) {
      pending = this.identifyForeground(ptyId).finally(() => this.identifies.delete(ptyId))
      this.identifies.set(ptyId, pending)
    }
    return withTimeoutResult(pending, TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS).then((result) =>
      result.ok ? result.value : undefined
    )
  }

  getPending(ptyId: string, afterTitle: number): Promise<boolean> | undefined {
    return this.refreshes.has(ptyId) ? this.refresh(ptyId, afterTitle) : undefined
  }

  getReads(): ReadonlyMap<string, PtyForegroundProcessReadEntry> {
    return this.reads
  }

  delaySnapshot(ptyId: string, titleAt: number, refresh: Promise<boolean>): void {
    this.delayedTitles.set(ptyId, titleAt)
    void refresh.then((changed) => {
      if (this.delayedTitles.get(ptyId) !== titleAt) {
        return
      }
      this.delayedTitles.delete(ptyId)
      this.deps.finishDelayedSnapshot(ptyId, changed)
    })
  }

  hasDelayedSnapshot(ptyId: string): boolean {
    return this.delayedTitles.has(ptyId)
  }

  forget(ptyId: string): void {
    this.delayedTitles.delete(ptyId)
    this.confirmedByPtyId.delete(ptyId)
    this.foregroundEpochs.delete(ptyId)
  }

  private async load(ptyId: string, afterTitle: number): Promise<boolean> {
    const controller = this.deps.getController()
    const pty = this.deps.getPty(ptyId)
    if (!controller || !pty?.connected || pty.launchAgent) {
      return false
    }
    const result = await this.read(ptyId, afterTitle)
    if (!result || result.controller !== this.deps.getController() || !result.available) {
      return false
    }
    const { agent, superseded } = await this.agentOfRead(ptyId, result)
    // The confirm scan awaits: a launch, disconnect or newer read in the meantime owns the pane instead.
    if (
      superseded ||
      result.controller !== this.deps.getController() ||
      this.deps.getPty(ptyId) !== pty ||
      !pty.connected ||
      pty.launchAgent ||
      pty.foregroundAgent === agent
    ) {
      return false
    }
    pty.foregroundAgent = agent
    this.deps.touchSnapshot(ptyId)
    return true
  }

  /** The agent now in the PTY's foreground, whoever launched it. */
  async identifyForeground(ptyId: string): Promise<TerminalAgent | null> {
    const controller = this.deps.getController()
    const pty = this.deps.getPty(ptyId)
    if (!controller || !pty?.connected) {
      return null
    }
    const result = await this.read(ptyId)
    if (!result || result.controller !== this.deps.getController() || !result.available) {
      return null
    }
    return (await this.agentOfRead(ptyId, result)).agent
  }

  /** The agent a foreground read names; a native Claude's version name is confirmed by one scan
   *  unless the pane's launch names Claude. `superseded`: a newer read or forget() overtook the scan. */
  private async agentOfRead(
    ptyId: string,
    result: PtyForegroundProcessRead
  ): Promise<{ agent: TerminalAgent | null; superseded: boolean }> {
    const foregroundName = result.process
    const agent = recognizeAgentProcess(foregroundName)?.agent ?? null
    const confirmed = this.confirmedByPtyId.get(ptyId)
    // Native Claude's p_comm is its versions/<semver> binary; only a process-table scan reads its argv.
    if (agent || !foregroundName || !NATIVE_CLAUDE_VERSION_NAME.test(foregroundName)) {
      // The tracker names `claude` for a second after a scan; that agrees with, not replaces, the scan.
      if (!agent || agent !== confirmed?.agent) {
        this.confirmedByPtyId.delete(ptyId)
        this.foregroundEpochs.delete(ptyId)
      }
      return { agent, superseded: false }
    }
    if (confirmed?.foregroundName === foregroundName) {
      return { agent: confirmed.agent, superseded: false }
    }
    // Windows native Claude is claude.exe (recognized by name), and confirm there forces a full scan.
    if (process.platform === 'win32') {
      return { agent: null, superseded: false }
    }
    const epoch = this.foregroundEpochs.get(ptyId) ?? {}
    this.foregroundEpochs.set(ptyId, epoch)
    // A surviving session's attach restores the agent Orca launched in it, which then needs no scan.
    await this.deps.pendingAttach(ptyId)
    if (this.deps.getPty(ptyId)?.launchAgent === 'claude') {
      return { agent: 'claude', superseded: this.foregroundEpochs.get(ptyId) !== epoch }
    }
    const confirmedAgent =
      recognizeAgentProcess(await this.confirm(result.controller, ptyId))?.agent ?? null
    const superseded = this.foregroundEpochs.get(ptyId) !== epoch
    if (result.controller !== this.deps.getController()) {
      return { agent: null, superseded }
    }
    // Only a recognized agent is kept, so a "not an agent" verdict is rescanned on the next dialog.
    if (confirmedAgent && !superseded) {
      this.confirmedByPtyId.set(ptyId, { foregroundName, agent: confirmedAgent })
    }
    return { agent: confirmedAgent, superseded }
  }

  private async confirm(controller: RuntimePtyController, ptyId: string): Promise<string | null> {
    try {
      return (await controller.confirmForegroundProcess?.(ptyId)) ?? null
    } catch {
      return null
    }
  }

  private deleteRead(ptyId: string, entry: PtyForegroundProcessReadEntry): void {
    if (this.reads.get(ptyId) === entry) {
      this.reads.delete(ptyId)
    }
  }
}
