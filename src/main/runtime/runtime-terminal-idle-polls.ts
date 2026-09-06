import { isShellProcess, type AgentStatus } from '../../shared/agent-detection'
import type { RuntimeTerminalWait } from '../../shared/runtime-types'
import {
  detectExplicitIdleStatusFromTitle,
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptPreview
} from './terminal-wait-detection'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult,
  buildTerminalWaitBlockedResult,
  buildTerminalWaitResult
} from './terminal-wait-results'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import type { TerminalWaiter } from './runtime-terminal-contracts'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

type RuntimeTerminalIdlePollDependencies = {
  intervalMs: number
  quiescenceMs: number
  getTabTitle(tabId: string): string | null
  getForegroundProcess(ptyId: string): Promise<string | null> | null
  getAdoptedPtyIdleStatus(pty: RuntimePtyWorktreeRecord): AgentStatus | null
  resolve(waiter: TerminalWaiter, result: RuntimeTerminalWait): void
}

type IdlePollEntry =
  | {
      kind: 'leaf'
      waiter: TerminalWaiter
      leaf: RuntimeLeafRecord
      foregroundPollInFlight: boolean
    }
  | {
      kind: 'pty'
      waiter: TerminalWaiter
      pty: RuntimePtyWorktreeRecord
      foregroundPollInFlight: boolean
    }

export class RuntimeTerminalIdlePolls {
  private readonly entries = new Set<IdlePollEntry>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: RuntimeTerminalIdlePollDependencies) {}

  startLeaf(waiter: TerminalWaiter, leaf: RuntimeLeafRecord): void {
    this.start({ kind: 'leaf', waiter, leaf, foregroundPollInFlight: false })
  }

  startPty(waiter: TerminalWaiter, pty: RuntimePtyWorktreeRecord): void {
    this.start({ kind: 'pty', waiter, pty, foregroundPollInFlight: false })
  }

  /** Test/diagnostic seam: live sweep handles, which must stay at most one. */
  get activeTimerCount(): number {
    return this.sweepTimer ? 1 : 0
  }

  private start(entry: IdlePollEntry): void {
    this.entries.add(entry)
    entry.waiter.cancelIdlePoll = () => this.stop(entry)
    // Why one shared timer for every waiter: a per-waiter interval multiplied idle
    // main-process wakeups by the number of concurrent `wait` calls, independent of
    // whether any terminal produced output. Same shape as the synthetic-title spinner.
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), this.deps.intervalMs)
    }
  }

  private sweep(): void {
    // Why a snapshot and no await: each entry must run its checks and then interleave
    // its own foreground read exactly as an independent interval callback did — one
    // slow `ps` must never delay another waiter's checks, and a waiter registered by a
    // resolve inside this sweep must wait for the next tick, as a fresh interval would.
    for (const entry of Array.from(this.entries)) {
      void (entry.kind === 'leaf' ? this.tickLeaf(entry) : this.tickPty(entry))
    }
  }

  private async tickLeaf(entry: IdlePollEntry & { kind: 'leaf' }): Promise<void> {
    if (!this.entries.has(entry)) {
      return
    }
    const { waiter, leaf } = entry
    let startedForegroundPoll = false
    try {
      if (leaf.lastAgentStatus === 'idle') {
        this.stop(entry)
        this.deps.resolve(waiter, buildTerminalWaitResult(waiter.handle, 'tui-idle', leaf))
        return
      }
      const title = leaf.paneTitle ?? this.deps.getTabTitle(leaf.tabId)
      if (title && detectExplicitIdleStatusFromTitle(title) === 'idle') {
        this.stop(entry)
        this.deps.resolve(waiter, buildTerminalWaitResult(waiter.handle, 'tui-idle', leaf))
        return
      }
      const waitText = buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
      const blockedReason = detectTerminalWaitBlockedReason(waitText)
      if (blockedReason) {
        this.stop(entry)
        this.deps.resolve(
          waiter,
          buildTerminalWaitBlockedResult(waiter.handle, 'tui-idle', leaf, blockedReason)
        )
        return
      }
      if (isKnownReadyPromptPreview(waitText)) {
        this.stop(entry)
        this.deps.resolve(waiter, buildTerminalWaitResult(waiter.handle, 'tui-idle', leaf))
        return
      }
      if (leaf.lastAgentStatus === null && leaf.ptyId && !entry.foregroundPollInFlight) {
        const foregroundRead = this.deps.getForegroundProcess(leaf.ptyId)
        if (!foregroundRead) {
          return
        }
        entry.foregroundPollInFlight = true
        startedForegroundPoll = true
        const foreground = await foregroundRead
        if (
          foreground &&
          !isShellProcess(foreground) &&
          (leaf.lastOutputAt ? Date.now() - leaf.lastOutputAt : 0) >= this.deps.quiescenceMs
        ) {
          this.stop(entry)
          this.deps.resolve(waiter, buildTerminalWaitResult(waiter.handle, 'tui-idle', leaf))
        }
      }
    } catch {
      // Transient process inspection errors do not retire the waiter.
    } finally {
      if (startedForegroundPoll) {
        entry.foregroundPollInFlight = false
      }
    }
  }

  private async tickPty(entry: IdlePollEntry & { kind: 'pty' }): Promise<void> {
    if (!this.entries.has(entry)) {
      return
    }
    const { waiter, pty } = entry
    let startedForegroundPoll = false
    try {
      if (pty.lastAgentStatus === 'idle') {
        this.stop(entry)
        this.deps.resolve(waiter, buildPtyTerminalWaitResult(waiter.handle, 'tui-idle', pty))
        return
      }
      const waitText = buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
      const blockedReason = detectTerminalWaitBlockedReason(waitText)
      if (blockedReason) {
        this.stop(entry)
        this.deps.resolve(
          waiter,
          buildPtyTerminalWaitBlockedResult(waiter.handle, 'tui-idle', pty, blockedReason)
        )
        return
      }
      if (
        this.deps.getAdoptedPtyIdleStatus(pty) === 'idle' ||
        isKnownReadyPromptPreview(waitText)
      ) {
        this.stop(entry)
        this.deps.resolve(waiter, buildPtyTerminalWaitResult(waiter.handle, 'tui-idle', pty))
        return
      }
      if (pty.lastAgentStatus === null && !entry.foregroundPollInFlight) {
        const foregroundRead = this.deps.getForegroundProcess(pty.ptyId)
        if (!foregroundRead) {
          return
        }
        entry.foregroundPollInFlight = true
        startedForegroundPoll = true
        const foreground = await foregroundRead
        if (
          foreground &&
          !isShellProcess(foreground) &&
          (pty.lastOutputAt ? Date.now() - pty.lastOutputAt : 0) >= this.deps.quiescenceMs
        ) {
          this.stop(entry)
          this.deps.resolve(waiter, buildPtyTerminalWaitResult(waiter.handle, 'tui-idle', pty))
        }
      }
    } catch {
      // Transient process inspection errors do not retire the waiter.
    } finally {
      if (startedForegroundPoll) {
        entry.foregroundPollInFlight = false
      }
    }
  }

  private stop(entry: IdlePollEntry): void {
    if (!this.entries.delete(entry)) {
      return
    }
    entry.waiter.cancelIdlePoll = null
    if (this.entries.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }
}
