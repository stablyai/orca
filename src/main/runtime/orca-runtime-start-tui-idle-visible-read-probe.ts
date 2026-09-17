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
  detectKnownReadyPromptAgent,
  type KnownReadyPromptAgent
} from './terminal-wait-detection'
import { observeTuiIdle, type TuiIdleEvidenceCursor } from './tui-idle-evidence'
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
import type { RuntimeScreenCapture } from './orca-runtime-core'

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
        visibleScreenOnly: true,
        freshVisibleCapture: true
      } satisfies RuntimeProviderSnapshotReadOptions),
      probeTimeoutMs,
      null
    )
      .then((projection) => {
        if (
          !projection ||
          projection.source !== 'screen' ||
          !this.terminalWaiters.get(waiter.handle)?.has(waiter) ||
          waiter.processIncarnation === null ||
          this.getTerminalProcessIncarnation(waiter.handle) !== waiter.processIncarnation
        ) {
          return
        }
        const snapshotText = projection.tail.join('\n')
        const blockedReason = detectTerminalWaitBlockedReason(snapshotText)
        const promptAgent = detectKnownReadyPromptAgent(snapshotText)
        const screenCapture = this.visibleScreenCaptureByPtyId.get(
          this.getLivePtyForHandle(waiter.handle)?.pty.ptyId ?? ''
        )
        const result = this.buildTuiIdleProbeResult(
          waiter.handle,
          blockedReason,
          promptAgent,
          waiter.evidenceCursor,
          screenCapture ?? null
        )
        if (!result) {
          return
        }
        if (waiter.cancelIdlePoll) {
          waiter.cancelIdlePoll()
        }
        this.terminalWaiters.resolve(waiter, result)
      })
      .catch(() => {})
  }

  protected buildTuiIdleProbeResult(
    handle: string,
    blockedReason: RuntimeTerminalWaitBlockedReason | null,
    promptAgent: KnownReadyPromptAgent | null,
    evidenceCursor?: TuiIdleEvidenceCursor,
    screenCapture?: RuntimeScreenCapture | null
  ): RuntimeTerminalWait | null {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      if (blockedReason) {
        return buildPtyTerminalWaitBlockedResult(handle, 'tui-idle', pty.pty, blockedReason)
      }
      const observation = observeTuiIdle({
        record: {
          ...pty.pty,
          lastOscTitleObservedAt: pty.pty.lastOscTitleEpochMs,
          attachmentId: this.getPtyAttachmentId(pty.pty.ptyId),
          screenCapture: screenCapture ?? null
        },
        rendererTitle: this.getAdoptedPtyTitle(pty.pty),
        readPositiveBodyEvidence: () => promptAgent !== null,
        positiveBodyEvidenceAgent: promptAgent,
        positiveBodyEvidenceSource: 'screen',
        agent: this.getPaneAgentForTuiIdle(pty.pty.ptyId),
        firstPartyStatus: pty.pty.lastExplicitAgentStatus ?? null,
        evidenceCursor
      })
      return observation.state === 'ready'
        ? buildPtyTerminalWaitResult(handle, 'tui-idle', pty.pty, {
            state: observation.state,
            source: observation.source,
            ...(observation.agent ? { agent: observation.agent } : {})
          })
        : null
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    if (blockedReason) {
      return buildTerminalWaitBlockedResult(handle, 'tui-idle', leaf, blockedReason)
    }
    const observation = observeTuiIdle({
      record: {
        ...leaf,
        attachmentId: leaf.ptyId ? this.getPtyAttachmentId(leaf.ptyId) : null,
        screenCapture: screenCapture ?? null
      },
      rendererTitle: leaf.paneTitle ?? this.tabs.get(leaf.tabId)?.title ?? null,
      readPositiveBodyEvidence: () => promptAgent !== null,
      positiveBodyEvidenceAgent: promptAgent,
      positiveBodyEvidenceSource: 'screen',
      agent: this.getPaneAgentForTuiIdle(leaf.ptyId),
      firstPartyStatus:
        (leaf.ptyId ? this.ptysById.get(leaf.ptyId)?.lastExplicitAgentStatus : null) ?? null,
      evidenceCursor
    })
    return observation.state === 'ready'
      ? buildTerminalWaitResult(handle, 'tui-idle', leaf, {
          state: observation.state,
          source: observation.source,
          ...(observation.agent ? { agent: observation.agent } : {})
        })
      : null
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
