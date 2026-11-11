import { OrcaRuntimeWithCreateAgentPromptRenderGate } from '../input/terminal-agent-prompt-render'
import type { RuntimeProviderSnapshotReadOptions } from '../output/provider-snapshot-read-options'
import type { TerminalWaiter } from './terminal-waiter'
import { VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from '../output/provider-snapshot-budget'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptBody,
  isKnownReadyPromptSettled
} from './terminal-wait-detection'
import { readsTrustedScreen } from '../../agent-state-rules/agent-state-rules-engine'
import { restoreProjectedComposerDraft } from '../view/orca-runtime-terminal-projection'
import { isBodyReadinessAgent, hasFreshWorkingFirstPartyStatus } from './tui-idle-evidence'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason
} from '../../../../shared/runtime-terminal-contracts'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult
} from './terminal-wait-results'
import { outputClockOf } from './tui-idle-evidence-source'
import { createSetupCompletionScanner } from '../../orchestration/workers/launch/setup-completion-signal'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
const TUI_IDLE_VISIBLE_PROBE_SETTLE_MARGIN_MS = 10
const TUI_IDLE_VISIBLE_PROBE_RETRY_MS = 2_000

/** Only a visibly working body-read agent needs the screen read again; every other outcome keeps the one-shot probe. */
export function visibleProbeNeedsRetry(
  agent: TuiAgent | null,
  working: boolean,
  remainingMs: number
): boolean {
  return isBodyReadinessAgent(agent) && working && remainingMs > TUI_IDLE_VISIBLE_PROBE_RETRY_MS
}

/** The probe settles only what the live screen would: agent rules for screen-ruled and body-read agents, else a settled ready preview. */
export function visibleProbeReady(args: {
  agent: TuiAgent | null
  screenRule: boolean
  snapshotText: string
  restoredLines: readonly string[]
  hasOutputClock: boolean
  /** First-party or title evidence that a turn is still open; body-read agents rank it above the composer. */
  working: boolean
}): boolean {
  if (isBodyReadinessAgent(args.agent) && args.working) {
    return false
  }
  return args.screenRule || isBodyReadinessAgent(args.agent)
    ? isKnownReadyPromptBody(
        args.snapshotText,
        args.agent,
        () => args.restoredLines,
        args.hasOutputClock
      )
    : isKnownReadyPromptSettled(args.snapshotText)
}

/** A body-read agent needs a real screen: its composer rule cannot judge a stream tail. */
export function visibleProbeReadsScreen(agent: TuiAgent | null, screenRule: boolean): boolean {
  return screenRule || isBodyReadinessAgent(agent)
}

export abstract class OrcaRuntimeWithStartTuiIdleVisibleReadProbe extends OrcaRuntimeWithCreateAgentPromptRenderGate {
  /** One bounded readiness read for adopted PTYs with lost metadata; a working body-read agent retries until its composer returns. */
  protected startTuiIdleVisibleReadProbe(
    waiter: TerminalWaiter,
    waiterTimeoutMs: number,
    agent: TuiAgent | null
  ): void {
    const settleMarginMs = Math.min(
      TUI_IDLE_VISIBLE_PROBE_SETTLE_MARGIN_MS,
      Math.max(1, Math.floor(waiterTimeoutMs / 3))
    )
    this.probeTuiIdleVisibleScreen(waiter, Date.now() + waiterTimeoutMs, agent, settleMarginMs)
  }

  private probeTuiIdleVisibleScreen(
    waiter: TerminalWaiter,
    deadline: number,
    agent: TuiAgent | null,
    settleMarginMs: number
  ): void {
    const remaining = deadline - Date.now()
    if (remaining < 1 || !this.terminalWaiters.has(waiter)) {
      return
    }
    const probeTimeoutMs = Math.min(
      VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS + settleMarginMs,
      Math.max(0, remaining - settleMarginMs)
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
      this.readTerminal(
        waiter.handle,
        visibleProbeReadsScreen(agent, screenRule) ? { screen: true } : {},
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
        const pty = this.ptysById.get(waiter.ptyId)
        if (
          !projection ||
          projection.source !== 'screen' ||
          !pty ||
          !this.terminalWaiters.has(waiter)
        ) {
          return
        }
        const working =
          pty.lastAgentStatus === 'working' ||
          hasFreshWorkingFirstPartyStatus(
            this.tuiIdleEvidenceSource.getFirstPartyAgentStatus(pty.ptyId)
          )
        // Why: a working turn can paint either prompt text, so never resolve readiness or a block from it.
        if (isBodyReadinessAgent(agent) && working) {
          if (visibleProbeNeedsRetry(agent, working, deadline - Date.now())) {
            setTimeout(
              () => this.probeTuiIdleVisibleScreen(waiter, deadline, agent, settleMarginMs),
              TUI_IDLE_VISIBLE_PROBE_RETRY_MS
            ).unref?.()
          }
          return
        }
        const snapshotText = projection.tail.join('\n')
        const blockedReason = detectTerminalWaitBlockedReason(snapshotText)
        const ready = visibleProbeReady({
          agent,
          screenRule,
          snapshotText,
          restoredLines: restoreProjectedComposerDraft(projection.tail, projection.draft),
          // Why read now: output since the probe started makes the pane clocked.
          hasOutputClock: outputClockOf(this.tuiIdleEvidenceSource, pty) !== null,
          working
        })
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
