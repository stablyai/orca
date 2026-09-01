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

export class RuntimeTerminalIdlePolls {
  constructor(private readonly deps: RuntimeTerminalIdlePollDependencies) {}

  startLeaf(waiter: TerminalWaiter, leaf: RuntimeLeafRecord): void {
    let foregroundPollInFlight = false
    waiter.pollInterval = setInterval(async () => {
      if (!waiter.pollInterval) {
        return
      }
      let startedForegroundPoll = false
      try {
        if (leaf.lastAgentStatus === 'idle') {
          this.stop(waiter)
          this.deps.resolve(waiter, buildTerminalWaitResult(waiter.handle, 'tui-idle', leaf))
          return
        }
        const title = leaf.paneTitle ?? this.deps.getTabTitle(leaf.tabId)
        if (title && detectExplicitIdleStatusFromTitle(title) === 'idle') {
          this.stop(waiter)
          this.deps.resolve(waiter, buildTerminalWaitResult(waiter.handle, 'tui-idle', leaf))
          return
        }
        const waitText = buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
        const blockedReason = detectTerminalWaitBlockedReason(waitText)
        if (blockedReason) {
          this.stop(waiter)
          this.deps.resolve(
            waiter,
            buildTerminalWaitBlockedResult(waiter.handle, 'tui-idle', leaf, blockedReason)
          )
          return
        }
        if (isKnownReadyPromptPreview(waitText)) {
          this.stop(waiter)
          this.deps.resolve(waiter, buildTerminalWaitResult(waiter.handle, 'tui-idle', leaf))
          return
        }
        if (leaf.lastAgentStatus === null && leaf.ptyId && !foregroundPollInFlight) {
          const foregroundRead = this.deps.getForegroundProcess(leaf.ptyId)
          if (!foregroundRead) {
            return
          }
          foregroundPollInFlight = true
          startedForegroundPoll = true
          const foreground = await foregroundRead
          if (
            foreground &&
            !isShellProcess(foreground) &&
            (leaf.lastOutputAt ? Date.now() - leaf.lastOutputAt : 0) >= this.deps.quiescenceMs
          ) {
            this.stop(waiter)
            this.deps.resolve(waiter, buildTerminalWaitResult(waiter.handle, 'tui-idle', leaf))
          }
        }
      } catch {
        // Transient process inspection errors do not retire the waiter.
      } finally {
        if (startedForegroundPoll) {
          foregroundPollInFlight = false
        }
      }
    }, this.deps.intervalMs)
  }

  startPty(waiter: TerminalWaiter, pty: RuntimePtyWorktreeRecord): void {
    let foregroundPollInFlight = false
    waiter.pollInterval = setInterval(async () => {
      if (!waiter.pollInterval) {
        return
      }
      let startedForegroundPoll = false
      try {
        if (pty.lastAgentStatus === 'idle') {
          this.stop(waiter)
          this.deps.resolve(waiter, buildPtyTerminalWaitResult(waiter.handle, 'tui-idle', pty))
          return
        }
        const waitText = buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
        const blockedReason = detectTerminalWaitBlockedReason(waitText)
        if (blockedReason) {
          this.stop(waiter)
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
          this.stop(waiter)
          this.deps.resolve(waiter, buildPtyTerminalWaitResult(waiter.handle, 'tui-idle', pty))
          return
        }
        if (pty.lastAgentStatus === null && !foregroundPollInFlight) {
          const foregroundRead = this.deps.getForegroundProcess(pty.ptyId)
          if (!foregroundRead) {
            return
          }
          foregroundPollInFlight = true
          startedForegroundPoll = true
          const foreground = await foregroundRead
          if (
            foreground &&
            !isShellProcess(foreground) &&
            (pty.lastOutputAt ? Date.now() - pty.lastOutputAt : 0) >= this.deps.quiescenceMs
          ) {
            this.stop(waiter)
            this.deps.resolve(waiter, buildPtyTerminalWaitResult(waiter.handle, 'tui-idle', pty))
          }
        }
      } catch {
        // Transient process inspection errors do not retire the waiter.
      } finally {
        if (startedForegroundPoll) {
          foregroundPollInFlight = false
        }
      }
    }, this.deps.intervalMs)
  }

  private stop(waiter: TerminalWaiter): void {
    if (!waiter.pollInterval) {
      return
    }
    clearInterval(waiter.pollInterval)
    waiter.pollInterval = null
  }
}
