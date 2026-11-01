import { OrcaRuntimeWithCreateAgentPromptRenderGate } from '../input/terminal-agent-prompt-render'
import type {
  RuntimeProviderSnapshotReadOptions,
  TerminalWaiter
} from '../../runtime-terminal-contracts'
import {
  TUI_IDLE_VISIBLE_PROBE_SETTLE_MARGIN_MS,
  VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS
} from '../../orca-runtime-postlude'
import { withTimeout } from '../../runtime-async-boundaries'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptBody,
  isKnownReadyPromptSettled
} from '../../terminal-wait-detection'
import { readsTrustedScreen } from '../../agent-state-rules/agent-state-rules-engine'
import { restoreProjectedComposerDraft } from '../../orca-runtime-terminal-projection'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason
} from '../../../../shared/runtime-terminal-contracts'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult
} from '../../terminal-wait-results'
import { outputClockOf } from '../../tui-idle-evidence-source'
import { createSetupCompletionScanner } from '../../orchestration/setup-completion-signal'
import type { TuiAgent } from '../../../../shared/tui-agent'

export abstract class OrcaRuntimeWithStartTuiIdleVisibleReadProbe extends OrcaRuntimeWithCreateAgentPromptRenderGate {
  /** One bounded readiness read for adopted PTYs with lost metadata; later working-to-idle transitions belong to the poll. */
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
    const screenRule = readsTrustedScreen(agent)
    void withTimeout(
      this.readTerminal(waiter.handle, screenRule ? { screen: true } : {}, {
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
        const pty = this.ptysById.get(waiter.ptyId)
        if (
          !projection ||
          projection.source !== 'screen' ||
          !pty ||
          !this.terminalWaiters.has(waiter)
        ) {
          return
        }
        const snapshotText = projection.tail.join('\n')
        const blockedReason = detectTerminalWaitBlockedReason(snapshotText)
        // Why the shared tier-1 rule: a probe must not settle what the live screen would refuse.
        const ready = screenRule
          ? isKnownReadyPromptBody(
              snapshotText,
              agent,
              () => restoreProjectedComposerDraft(projection.tail, projection.draft),
              // Why read now: output since the probe started makes the pane clocked.
              outputClockOf(this.tuiIdleEvidenceSource, pty) !== null
            )
          : isKnownReadyPromptSettled(snapshotText)
        if (!blockedReason && !ready) {
          return
        }
        const result = blockedReason
          ? buildPtyTerminalWaitBlockedResult(waiter.handle, 'tui-idle', pty, blockedReason)
          : buildPtyTerminalWaitResult(waiter.handle, 'tui-idle', pty)
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
    const { pty } = this.getTerminalPtyForHandle(handle)
    return blockedReason
      ? buildPtyTerminalWaitBlockedResult(handle, 'tui-idle', pty, blockedReason)
      : buildPtyTerminalWaitResult(handle, 'tui-idle', pty)
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
