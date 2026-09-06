// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCreateAgentPromptRenderGate } from './orca-runtime-create-agent-prompt-render-gate'
import type {
  RuntimeProviderSnapshotReadOptions,
  TerminalWaiter
} from './runtime-terminal-contracts'
import {
  TUI_IDLE_VISIBLE_PROBE_SETTLE_MARGIN_MS,
  VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS
} from './orca-runtime-postlude'
import { withTimeout } from './runtime-async-boundaries'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptPreview
} from './terminal-wait-detection'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason
} from '../../shared/runtime-types'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult,
  buildTerminalWaitBlockedResult,
  buildTerminalWaitResult
} from './terminal-wait-results'
import { createSetupCompletionScanner } from './orchestration/setup-completion-signal'

export class OrcaRuntimeWithStartTuiIdleVisibleReadProbe extends OrcaRuntimeWithCreateAgentPromptRenderGate {
  /** One bounded look at the provider's screen for an adopted PTY whose retained
   *  readiness metadata was lost. Deliberately single-shot: it answers "is the
   *  screen already showing a settled prompt", and the poll above owns every
   *  later transition. A provider screen that is still working when this fires
   *  resolves through the poll, not here. */
  protected startTuiIdleVisibleReadProbe(waiter: TerminalWaiter, waiterTimeoutMs: number): void {
    const settleMarginMs = Math.min(
      TUI_IDLE_VISIBLE_PROBE_SETTLE_MARGIN_MS,
      Math.max(1, Math.floor(waiterTimeoutMs / 3))
    )
    const probeTimeoutMs = Math.min(
      VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS + settleMarginMs,
      Math.max(0, waiterTimeoutMs - settleMarginMs)
    )
    const providerTimeoutMs = Math.min(
      VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
      Math.max(0, probeTimeoutMs - settleMarginMs)
    )
    if (providerTimeoutMs < 1) {
      return
    }
    void withTimeout(
      this.readTerminal(waiter.handle, {}, {
        timeoutMs: providerTimeoutMs,
        retireOnTimeout: true,
        // Why: the ready banner stays in scrollback for the whole session, so
        // classifying history would call a working agent idle (#15569 review).
        visibleScreenOnly: true
      } satisfies RuntimeProviderSnapshotReadOptions),
      probeTimeoutMs,
      null
    )
      .then((projection) => {
        if (
          !projection ||
          projection.source !== 'screen' ||
          !this.terminalWaiters.get(waiter.handle)?.has(waiter)
        ) {
          return
        }
        const snapshotText = projection.tail.join('\n')
        const blockedReason = detectTerminalWaitBlockedReason(snapshotText)
        if (!blockedReason && !isKnownReadyPromptPreview(snapshotText)) {
          return
        }
        const result = this.buildTuiIdleProbeResult(waiter.handle, blockedReason)
        if (waiter.cancelIdlePoll) {
          waiter.cancelIdlePoll()
        }
        this.terminalWaiters.resolve(waiter, result)
      })
      .catch(() => {})
  }

  protected buildTuiIdleProbeResult(
    handle: string,
    blockedReason: RuntimeTerminalWaitBlockedReason | null
  ): RuntimeTerminalWait {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      return blockedReason
        ? buildPtyTerminalWaitBlockedResult(handle, 'tui-idle', pty.pty, blockedReason)
        : buildPtyTerminalWaitResult(handle, 'tui-idle', pty.pty)
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    return blockedReason
      ? buildTerminalWaitBlockedResult(handle, 'tui-idle', leaf, blockedReason)
      : buildTerminalWaitResult(handle, 'tui-idle', leaf)
  }

  async waitForSetupTerminalCompletion(handle: string): Promise<{ exitCode: number | null }> {
    const ptyId = this.getLivePtyForHandle(handle)?.pty.ptyId
    if (!ptyId) {
      throw new Error('terminal_handle_stale')
    }
    const completionToken = this.setupCompletionTokenByPtyId.get(ptyId)
    const exitAbort = new AbortController()
    return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
      let settled = false
      let unsubscribe: (() => void) | null = null
      const cleanup = (): void => {
        unsubscribe?.()
        exitAbort.abort()
      }
      const finish = (exitCode: number | null): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        this.setupCompletionTokenByPtyId.delete(ptyId)
        resolve({ exitCode })
      }
      const fail = (error: unknown): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
      }
      const scanner = completionToken ? createSetupCompletionScanner(completionToken, finish) : null

      if (scanner) {
        unsubscribe = this.subscribeToTerminalData(ptyId, scanner.scan)
      }
      // Why: setup can finish before the observer is registered on fast local worktrees.
      const replay = this.recentPtyOutputById.get(ptyId)?.read()
      if (scanner && replay) {
        scanner.scan(replay)
      }
      if (!settled) {
        void this.waitForTerminal(handle, {
          condition: 'exit',
          signal: exitAbort.signal
        })
          .then((wait) => {
            if (wait.satisfied && wait.condition === 'exit' && wait.status === 'exited') {
              finish(wait.exitCode)
            }
          })
          .catch(fail)
      }
    })
  }
}
