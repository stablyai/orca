import { createSetupDependentCommand } from '../../../../shared/agent-launch/startup/setup-attempt-recipe'
import type { AgentStartupShell } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { recognizeAgentLaunchCommand } from '../../../../shared/agent-launch/startup/agent-command-line-intent'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import { OrcaRuntimeWithCreateAgentPromptRenderGate } from '../input/terminal-agent-prompt-render'
import type { RuntimeProviderSnapshotReadOptions } from '../output/provider-snapshot-read-options'
import type { TerminalWaiter } from './terminal-waiter'
import { VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from '../output/provider-snapshot-budget'
import { withTimeout } from '../../../../shared/concurrency/promise-timeout-fallback'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptBody,
  isKnownReadyPromptSettled
} from './terminal-wait-detection'
import { readsTrustedScreen } from '../../agent-state-rules/agent-state-rules-engine'
import { restoreProjectedComposerDraft } from '../view/orca-runtime-terminal-projection'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason
} from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult
} from './terminal-wait-results'
import { outputClockOf } from './tui-idle-evidence-source'
import { createSetupCompletionScanner } from '../../orchestration/workers/launch/setup-completion-signal'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
const TUI_IDLE_VISIBLE_PROBE_SETTLE_MARGIN_MS = 10

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

  async prepareTerminalSetupForSpawn(args: {
    workspaceId: string
    command?: string
    agent?: string | null
    shell: AgentStartupShell
    shellExecutable?: string
    sessionId?: string
    signal?: AbortSignal
  }) {
    if (this.setupTerminalCompletions.isWriter(args.sessionId)) {
      return undefined
    }
    const agent =
      args.agent ??
      recognizeAgentLaunchCommand(args.command ?? '', { includeHeadlessOneShot: true })?.agent
    if (!agent) {
      return undefined
    }
    const gate = this.setupTerminalCompletions.gate(args.workspaceId)
    const attempt = await (args.signal ? waitForPromiseWithSignal(gate, args.signal) : gate)
    if (!attempt) {
      return undefined
    }
    if (attempt.settled) {
      const { exitCode } = await attempt.completion
      if (exitCode !== 0) {
        throw new Error(
          `${agent} did not start because Setup did not finish successfully. Check the Setup terminal and try again.`
        )
      }
      return undefined
    }
    if (!attempt.recipe || attempt.recipe.deadline <= Date.now()) {
      throw new Error(
        `${agent} did not start because Setup did not finish successfully. Check the Setup terminal and try again.`
      )
    }
    const recipe = {
      ...attempt.recipe,
      shell:
        args.shell === 'posix'
          ? { family: 'posix' as const, executable: args.shellExecutable }
          : { family: 'cmd' as const }
    }
    return {
      ...(args.command ? createSetupDependentCommand(recipe, args.command, args.shell) : {}),
      bind: (ptyId: string) =>
        this.setupTerminalCompletions.bindDependent(args.workspaceId, ptyId, attempt.completion)
    }
  }

  async waitForTerminalSetup(handle: string, agent: string, signal?: AbortSignal): Promise<void> {
    const ptyId = this.getLivePtyForHandle(handle)?.pty.ptyId
    if (ptyId) {
      await this.waitForPtySetup(ptyId, agent, signal)
    }
  }

  async waitForPtySetup(ptyId: string, agent = 'Agent', signal?: AbortSignal): Promise<void> {
    const completion = this.setupTerminalCompletions.forDependent(ptyId)
    if (!completion) {
      return
    }
    const outcome = await (signal ? waitForPromiseWithSignal(completion, signal) : completion)
    if (outcome.exitCode !== 0) {
      throw new Error(
        `${agent} did not start because Setup did not finish successfully. Check the Setup terminal and try again.`
      )
    }
  }

  beginWorkspaceSetup(workspaceId: string): void {
    this.setupTerminalCompletions.beginWorkspace(workspaceId)
  }

  refuseWorkspaceSetup(workspaceId: string): void {
    this.setupTerminalCompletions.refuseWorkspace(workspaceId)
  }

  preparedWorkspaceSetup(workspaceId: string, required: boolean): void {
    this.setupTerminalCompletions.preparedWorkspace(workspaceId, required)
  }

  async waitForWorkspaceSetup(
    workspaceId: string,
    agent: string,
    signal?: AbortSignal
  ): Promise<void> {
    const completion = this.setupTerminalCompletions.forWorkspace(workspaceId)
    const outcome =
      completion && (await (signal ? waitForPromiseWithSignal(completion, signal) : completion))
    if (outcome && outcome.exitCode !== 0) {
      throw new Error(
        `${agent} did not start because Setup did not finish successfully. Check the Setup terminal and try again.`
      )
    }
  }

  async waitForSetupTerminalCompletion(
    handle: string,
    signal?: AbortSignal
  ): Promise<{ exitCode: number | null }> {
    const retained = this.setupTerminalCompletions.forHandle(handle)
    if (retained) {
      return await new Promise((resolve, reject) => {
        const onAbort = (): void => reject(signal?.reason ?? new Error('request_aborted'))
        if (signal?.aborted) {
          return onAbort()
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        void retained.then(resolve).finally(() => signal?.removeEventListener('abort', onAbort))
      })
    }
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
              finish(null)
            }
          })
          .catch(fail)
      }
    })
  }
}
