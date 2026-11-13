import { recognizeAgentProcess } from '../../../../shared/agent-status/process/agent-process-recognition'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { withTimeoutResult } from '../../../../shared/promise-timeout-fallback'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from '../wait/terminal-interactive-probe-budget'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type {
  PtyForegroundAgentRefresh,
  PtyForegroundProcessRead,
  PtyForegroundProcessReadEntry
} from './pty-foreground-observation-state'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { PtyStartupObservation } from './pty-startup-observation'
import {
  readPtyForegroundObservation,
  confirmPtyForegroundAgent
} from './pty-foreground-observation'

type Dependencies = {
  getController(): RuntimePtyController | null
  getPty(ptyId: string): RuntimePtyWorktreeRecord | null
  touchSnapshot(ptyId: string): void
  finishDelayedSnapshot(ptyId: string, changed: boolean): void
}

const NATIVE_CLAUDE_VERSION_NAME = /^\d+\.\d+\.\d+$/

export class RuntimePtyForegroundAgent {
  private readonly refreshes = new Map<string, PtyForegroundAgentRefresh>()
  private readonly reads = new Map<string, PtyForegroundProcessReadEntry>()
  private readonly delayedTitles = new Map<string, number>()
  private readonly identifies = new Map<string, Promise<TerminalAgent | null>>()
  readonly startup: PtyStartupObservation
  // A scan's recognized agent for a version name holds while that name stays in the foreground.
  private readonly confirmedByPtyId = new Map<
    string,
    {
      foregroundName: string
      agent: TerminalAgent
      controller: RuntimePtyController
      pty: RuntimePtyWorktreeRecord
      incarnation: RuntimePtyWorktreeRecord['incarnationId']
      reset: number | undefined
      paint: RuntimePtyWorktreeRecord['commandPaint']
      epoch: number
    }
  >()

  constructor(private readonly deps: Dependencies) {
    this.startup = new PtyStartupObservation({
      ...deps,
      read: (ptyId, generation, isCurrent) => this.read(ptyId, 0, { generation, isCurrent })
    })
  }

  read(
    ptyId: string,
    afterTitle = 0,
    observation?: { generation: object; isCurrent(): boolean }
  ): Promise<PtyForegroundProcessRead> | null {
    const controller = this.deps.getController()
    if (!controller) {
      return null
    }
    const current = this.captureGeneration(ptyId)
    const unavailable: PtyForegroundProcessRead = { controller, process: null, available: false }
    if (!current() || (observation && !observation.isCurrent())) {
      return Promise.resolve(unavailable)
    }
    const pending = this.reads.get(ptyId)
    if (
      pending?.isCurrent() &&
      pending.controller === controller &&
      pending.startedAfterTitleObservation >= afterTitle &&
      (!observation || pending.observationGeneration === observation.generation)
    ) {
      return pending.promise
    }
    if (pending?.controller === controller) {
      return pending.promise.then(() =>
        !current() || (observation && !observation.isCurrent())
          ? unavailable
          : (this.read(ptyId, afterTitle, observation) ?? unavailable)
      )
    }
    let processRead: Promise<PtyForegroundProcessRead>
    try {
      processRead = observation
        ? readPtyForegroundObservation(
            controller,
            ptyId,
            this.deps.getPty(ptyId)?.incarnationId,
            () => current() && observation.isCurrent()
          )
        : Promise.resolve(controller.getForegroundProcess(ptyId)).then((process) => ({
            controller,
            process,
            available: true
          }))
    } catch {
      const entry: PtyForegroundProcessReadEntry = {
        controller,
        startedAfterTitleObservation: afterTitle,
        promise: Promise.resolve(unavailable),
        isCurrent: current
      }
      entry.promise = entry.promise.finally(() => this.deleteRead(ptyId, entry))
      this.reads.set(ptyId, entry)
      return entry.promise
    }
    let entry: PtyForegroundProcessReadEntry
    const promise = processRead
      .then((result) => (current() ? result : unavailable))
      .catch(() => unavailable)
      .finally(() => this.deleteRead(ptyId, entry))
    entry = {
      controller,
      startedAfterTitleObservation: afterTitle,
      promise,
      observationGeneration: observation?.generation,
      isCurrent: current
    }
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
      while (true) {
        entry.startedAfterTitleObservation = entry.requestedAfterTitleObservation
        const changed = await this.load(ptyId, entry.startedAfterTitleObservation)
        if (changed || entry.requestedAfterTitleObservation <= entry.startedAfterTitleObservation) {
          return changed
        }
      }
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
      pending = this.identifyForeground(ptyId).finally(() => {
        if (this.identifies.get(ptyId) === pending) {
          this.identifies.delete(ptyId)
        }
      })
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

  forget(ptyId: string, preserveStartupInterest = false): void {
    this.delayedTitles.delete(ptyId)
    this.confirmedByPtyId.delete(ptyId)
    this.startup.forget(ptyId, preserveStartupInterest)
  }

  private async load(ptyId: string, afterTitle: number): Promise<boolean> {
    const controller = this.deps.getController()
    const pty = this.deps.getPty(ptyId)
    if (!controller || !pty?.connected || pty.launchAgent) {
      return false
    }
    const current = this.captureGeneration(ptyId)
    const result = await this.read(ptyId, afterTitle)
    if (
      !current() ||
      !result ||
      result.controller !== this.deps.getController() ||
      !result.available
    ) {
      return false
    }
    const agent = result.agent ?? recognizeAgentProcess(result.process)?.agent ?? null
    if (pty.foregroundAgent === agent) {
      return false
    }
    pty.foregroundAgent = agent
    this.deps.touchSnapshot(ptyId)
    return true
  }

  async identifyForeground(ptyId: string): Promise<TerminalAgent | null> {
    const controller = this.deps.getController()
    const pty = this.deps.getPty(ptyId)
    if (!controller || !pty?.connected) {
      return null
    }
    const current = this.captureGeneration(ptyId)
    const result = await this.read(ptyId)
    if (
      !current() ||
      !result ||
      result.controller !== this.deps.getController() ||
      !result.available
    ) {
      return null
    }
    const foregroundName = result.process
    const agent = result.agent ?? recognizeAgentProcess(foregroundName)?.agent ?? null
    // Native Claude's p_comm is its versions/<semver> binary; only a process-table scan reads its argv.
    if (agent || !foregroundName || !NATIVE_CLAUDE_VERSION_NAME.test(foregroundName)) {
      this.confirmedByPtyId.delete(ptyId)
      return agent
    }
    const confirmed = this.confirmedByPtyId.get(ptyId)
    if (
      confirmed?.foregroundName === foregroundName &&
      confirmed.controller === controller &&
      confirmed.pty === pty &&
      confirmed.incarnation === pty.incarnationId &&
      confirmed.reset === pty.providerGenerationResetAtEpochMs &&
      confirmed.paint === pty.commandPaint &&
      confirmed.epoch === (pty.commandPaint?.commandEpoch ?? 0)
    ) {
      return confirmed.agent
    }
    // Windows native Claude is claude.exe (recognized by name), and confirm there forces a full scan.
    if (process.platform === 'win32') {
      return null
    }
    const confirmedAgent = await confirmPtyForegroundAgent(result.controller, ptyId)
    if (!current() || result.controller !== this.deps.getController()) {
      return null
    }
    // Only a recognized agent is kept, so a "not an agent" verdict is rescanned on the next dialog.
    if (confirmedAgent) {
      this.confirmedByPtyId.set(ptyId, {
        foregroundName,
        agent: confirmedAgent,
        controller,
        pty,
        incarnation: pty.incarnationId,
        reset: pty.providerGenerationResetAtEpochMs,
        paint: pty.commandPaint,
        epoch: pty.commandPaint?.commandEpoch ?? 0
      })
    }
    return confirmedAgent
  }

  captureGeneration(ptyId: string): () => boolean {
    const controller = this.deps.getController()
    const pty = this.deps.getPty(ptyId)
    const incarnation = pty?.incarnationId
    const reset = pty?.providerGenerationResetAtEpochMs
    const paint = pty?.commandPaint
    const { commandEpoch: epoch, commandActive: active } = paint ?? {}
    return () =>
      pty?.connected === true &&
      this.deps.getController() === controller &&
      this.deps.getPty(ptyId) === pty &&
      pty?.incarnationId === incarnation &&
      pty?.providerGenerationResetAtEpochMs === reset &&
      pty?.commandPaint === paint &&
      !paint?.commandBoundaryPending &&
      paint?.commandEpoch === epoch &&
      paint?.commandActive === active
  }

  private deleteRead(ptyId: string, entry: PtyForegroundProcessReadEntry): void {
    if (this.reads.get(ptyId) === entry) {
      this.reads.delete(ptyId)
    }
  }
}
