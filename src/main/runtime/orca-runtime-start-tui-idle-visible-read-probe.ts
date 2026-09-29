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
import { detectTerminalWaitBlockedReason, isKnownReadyPromptBody } from './terminal-wait-detection'
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
import type { TuiAgent } from '../../shared/tui-agent'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { isVisibleReadProbeIdentityCurrent } from './visible-read-probe-identity'
import {
  beginVisibleReadProbeRead,
  createVisibleReadProbeRetryState,
  finishVisibleReadProbeRead,
  hasCurrentVisibleReadProbeComposerSignal,
  noteVisibleReadProbeComposerSignal,
  noteVisibleReadProbeEvent,
  shouldRetryVisibleReadProbeRead
} from './visible-read-probe-retry'

export class OrcaRuntimeWithStartTuiIdleVisibleReadProbe extends OrcaRuntimeWithCreateAgentPromptRenderGate {
  /** One bounded look at the provider's screen for an adopted PTY whose retained
   *  readiness metadata was lost. Deliberately single-shot: it answers "is the
   *  screen already showing a settled prompt", and the poll above owns every
   *  later transition. A provider screen that is still working when this fires
   *  resolves through the poll, not here. */
  protected startTuiIdleVisibleReadProbe(
    waiter: TerminalWaiter,
    waiterTimeoutMs: number,
    agent: TuiAgent | null
  ): void {
    // Capture the exact surface before the provider read. A waiter handle can be rebound while
    // the read is in flight, and a provider can respawn the same pty id under a new lifecycle.
    // Applying that response to the replacement would turn an old screen into readiness.
    let initialPty: ReturnType<typeof this.getLivePtyForHandle>
    let initialLeaf: ReturnType<typeof this.getLiveLeafForHandle>['leaf'] | null = null
    let initialHandleRecord: ReturnType<typeof this.getLiveLeafForHandle>['record'] | null = null
    try {
      initialPty = this.getLivePtyForHandle(waiter.handle)
      if (!initialPty) {
        const liveLeaf = this.getLiveLeafForHandle(waiter.handle)
        initialHandleRecord = liveLeaf.record
        initialLeaf = liveLeaf.leaf
      } else {
        initialHandleRecord = initialPty.record
      }
    } catch {
      return
    }
    const ptyId = initialPty?.pty.ptyId ?? initialLeaf?.ptyId ?? null
    if (!ptyId) {
      return
    }
    const rendererGraphEpoch =
      initialPty?.record.rendererGraphEpoch ?? initialHandleRecord?.rendererGraphEpoch ?? null
    const ptyGeneration = initialPty?.record.ptyGeneration ?? initialLeaf?.ptyGeneration ?? null
    const lifecycleGeneration = this.getPtyLifecycleGeneration(ptyId)
    const capturedIdentity = {
      ptyId,
      rendererGraphEpoch,
      ptyGeneration,
      lifecycleGeneration
    }
    const isCurrentProbe = (): boolean => {
      try {
        const currentPty = this.getLivePtyForHandle(waiter.handle)
        const currentLeafRecord = currentPty ? null : this.getLiveLeafForHandle(waiter.handle)
        const currentLeaf = currentLeafRecord?.leaf ?? null
        const currentPtyId = currentPty?.pty.ptyId ?? currentLeaf?.ptyId ?? null
        const currentRendererGraphEpoch =
          currentPty?.record.rendererGraphEpoch ??
          currentLeafRecord?.record.rendererGraphEpoch ??
          null
        const currentPtyGeneration =
          currentPty?.record.ptyGeneration ?? currentLeaf?.ptyGeneration ?? null
        return isVisibleReadProbeIdentityCurrent(
          capturedIdentity,
          {
            ptyId: currentPtyId ?? '',
            rendererGraphEpoch: currentRendererGraphEpoch,
            ptyGeneration: currentPtyGeneration,
            lifecycleGeneration: this.getPtyLifecycleGeneration(ptyId)
          },
          Boolean(this.terminalWaiters.get(waiter.handle)?.has(waiter))
        )
      } catch {
        return false
      }
    }
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
    const codexComposerScanner =
      agent === 'codex' ? createDraftPasteReadyScanner('codex-composer-prompt') : null
    const readRetryState = createVisibleReadProbeRetryState()
    let closed = false
    let unsubscribe: (() => void) | null = null
    let cleanupTimer: NodeJS.Timeout | null = null
    const cleanup = (): void => {
      closed = true
      unsubscribe?.()
      unsubscribe = null
      if (cleanupTimer) {
        clearTimeout(cleanupTimer)
        cleanupTimer = null
      }
    }
    const readAndClassify = (): void => {
      if (closed) {
        return
      }
      const requestedScreenEpoch = beginVisibleReadProbeRead(readRetryState)
      if (requestedScreenEpoch === null) {
        return
      }
      void withTimeout(
        this.readTerminal(waiter.handle, agent === 'antigravity' ? { screen: true } : {}, {
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
          if (!projection || closed || !isCurrentProbe()) {
            return
          }
          // A PTY event during the provider snapshot makes that screen a historical frame. Do
          // not settle from it; the finalizer below coalesces the event into one fresh read.
          if (shouldRetryVisibleReadProbeRead(readRetryState, requestedScreenEpoch)) {
            return
          }
          const hasScreen = projection.source === 'screen'
          const currentCodexComposerSignal =
            hasCurrentVisibleReadProbeComposerSignal(readRetryState)
          if (!hasScreen && !currentCodexComposerSignal) {
            return
          }
          const snapshotText =
            agent === 'antigravity'
              ? [...projection.tail, projection.draft ?? ''].join('\n')
              : projection.tail.join('\n')
          const blockedReason = detectTerminalWaitBlockedReason(snapshotText)
          const ready =
            agent === 'antigravity'
              ? hasScreen && isAntigravityReadyPromptSnapshot(snapshotText)
              : isKnownReadyPromptBody(
                  hasScreen ? snapshotText : '',
                  agent,
                  () => (hasScreen ? projection.tail : null),
                  () => currentCodexComposerSignal
                )
          if (!blockedReason && !ready) {
            return
          }
          if (!isCurrentProbe()) {
            return
          }
          closed = true
          cleanup()
          const result = this.buildTuiIdleProbeResult(waiter.handle, blockedReason)
          if (waiter.cancelIdlePoll) {
            waiter.cancelIdlePoll()
          }
          this.terminalWaiters.resolve(waiter, result)
        })
        .catch(() => {})
        .finally(() => {
          if (finishVisibleReadProbeRead(readRetryState) && !closed) {
            readAndClassify()
          }
        })
    }
    if (codexComposerScanner) {
      unsubscribe = this.subscribeToTerminalData(ptyId, (data) => {
        if (closed) {
          return
        }
        noteVisibleReadProbeEvent(readRetryState)
        if (codexComposerScanner.observe(data).ready) {
          noteVisibleReadProbeComposerSignal(readRetryState)
        }
        readAndClassify()
      })
    }
    cleanupTimer = setTimeout(cleanup, probeTimeoutMs)
    readAndClassify()
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
