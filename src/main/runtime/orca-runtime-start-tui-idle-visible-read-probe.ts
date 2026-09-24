// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCreateAgentPromptRenderGate } from './orca-runtime-create-agent-prompt-render-gate'
import type {
  RuntimeProviderSnapshotReadOptions,
  TerminalWaiter
} from './runtime-terminal-contracts'
import {
  TUI_IDLE_POLL_INTERVAL_MS,
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
import { isAntigravityReadyPromptSnapshot } from './antigravity-terminal-readiness'
import { isHermesReadyPromptSnapshot } from './hermes-terminal-readiness'
import type { TuiAgent } from '../../shared/tui-agent'

export class OrcaRuntimeWithStartTuiIdleVisibleReadProbe extends OrcaRuntimeWithCreateAgentPromptRenderGate {
  /** Hermes repaints the grid without a usable retained tail; unlike other agents,
   *  it needs bounded screen retries while the same waiter remains live. */
  protected startTuiIdleVisibleReadProbe(
    waiter: TerminalWaiter,
    waiterTimeoutMs: number,
    agent: TuiAgent | null
  ): void {
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
    const probe = (): void => {
      if (!this.terminalWaiters.get(waiter.handle)?.has(waiter)) {
        return
      }
      void withTimeout(
        this.readTerminal(
          waiter.handle,
          agent === 'antigravity' || agent === 'hermes' ? { screen: true } : {},
          {
            timeoutMs: providerTimeoutMs,
            retireOnTimeout: true,
            // Why: the ready banner stays in scrollback for the whole session, so
            // classifying history would call a working agent idle (#15569 review).
            visibleScreenOnly: true
          } satisfies RuntimeProviderSnapshotReadOptions
        ),
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
          const snapshotText =
            agent === 'antigravity'
              ? [...projection.tail, projection.draft ?? ''].join('\n')
              : projection.tail.join('\n')
          const blockedReason = detectTerminalWaitBlockedReason(snapshotText)
          let ready = false
          if (agent === 'antigravity') {
            ready = isAntigravityReadyPromptSnapshot(snapshotText)
          } else if (agent === 'hermes') {
            ready = isHermesReadyPromptSnapshot(snapshotText)
          } else {
            ready = isKnownReadyPromptPreview(snapshotText)
          }
          if (!blockedReason && !ready) {
            return
          }
          const result = this.buildTuiIdleProbeResult(waiter.handle, blockedReason)
          if (waiter.cancelIdlePoll) {
            waiter.cancelIdlePoll()
          }
          this.terminalWaiters.resolve(waiter, result)
        })
        .catch(() => {})
        .finally(() => {
          if (agent !== 'hermes' || !this.terminalWaiters.get(waiter.handle)?.has(waiter)) {
            return
          }
          const retry = setTimeout(probe, TUI_IDLE_POLL_INTERVAL_MS)
          retry.unref?.()
        })
    }
    probe()
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

  async waitForSetupTerminalCompletion(
    handle: string,
    signal?: AbortSignal
  ): Promise<{ exitCode: number | null }> {
    const ptyId = this.getLivePtyForHandle(handle)?.pty.ptyId
    if (!ptyId) {
      throw new Error('terminal_handle_stale')
    }
    const completionToken = this.setupCompletionTokenByPtyId.get(ptyId)
    const exitAbort = new AbortController()
    return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
      let settled = false
      let unsubscribe: (() => void) | null = null
      const onAbort = (): void => {
        fail(signal?.reason ?? new Error('request_aborted'))
      }
      const cleanup = (): void => {
        unsubscribe?.()
        exitAbort.abort()
        signal?.removeEventListener('abort', onAbort)
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
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
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
