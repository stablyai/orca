import type {
  RuntimeTerminalWait as RuntimeTerminalWaitResult,
  RuntimeTerminalWaitCondition
} from '../../../../shared/runtime-terminal-contracts'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult
} from '../../terminal-wait-results'
import { readsTrustedScreen } from '../../agent-state-rules/agent-state-rules-engine'
import { showsScreenProbeBanner } from '../../agent-state-rules/agent-state-text-anchors'
import { buildTerminalWaitText } from '../../terminal-wait-tail-state'
import { evaluateTuiIdle, type TuiIdleVerdict } from '../../tui-idle-evidence'
import {
  outputClockOf,
  ptyTuiIdleEvidence,
  type TuiIdleEvidenceSource
} from '../../tui-idle-evidence-source'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { TerminalWaiter } from '../../runtime-terminal-contracts'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { RuntimeTerminalIdlePolls } from './terminal-idle-polls'
import type { RuntimeTerminalWaiterRegistry } from './terminal-waiter-registry'

/** Probe unseen/provider-only panes and clockless screen-ruled agents with untrusted restored models; clocked panes settle through quiet polling. profile.screenProbeBanner also opts in. */
function shouldProbeVisibleScreen(
  paneAgent: TuiAgent | null,
  record: Pick<RuntimePtyWorktreeRecord, 'lastAgentStatus'>,
  outputClockAt: number | null,
  waitText: string
): boolean {
  return (
    (record.lastAgentStatus === null && waitText.length === 0) ||
    showsScreenProbeBanner(waitText) ||
    (readsTrustedScreen(paneAgent) && outputClockAt === null)
  )
}

type RuntimeTerminalWaitDependencies = TuiIdleEvidenceSource & {
  defaultTimeoutMs: number
  /** The terminal a handle names; throws `terminal_handle_stale` when it names none. */
  getTerminalPty(handle: string): { pty: RuntimePtyWorktreeRecord }
  /** A disconnected terminal that may still run, so an exit wait keeps waiting for its end. */
  exitUnsettled(pty: RuntimePtyWorktreeRecord): boolean
  startVisibleReadProbe(
    waiter: TerminalWaiter,
    waiterTimeoutMs: number,
    agent: TuiAgent | null
  ): void
}

export class RuntimeTerminalWait {
  constructor(
    private readonly deps: RuntimeTerminalWaitDependencies,
    private readonly waiters: RuntimeTerminalWaiterRegistry,
    private readonly polls: RuntimeTerminalIdlePolls
  ) {}

  /** Why one helper: the immediate check and the poll must rank the same terminal the same way. */
  private evaluate(pty: RuntimePtyWorktreeRecord, waitText: string): TuiIdleVerdict {
    return evaluateTuiIdle(ptyTuiIdleEvidence(this.deps, pty, () => waitText))
  }

  async wait(
    handle: string,
    options?: {
      condition?: RuntimeTerminalWaitCondition
      timeoutMs?: number
      signal?: AbortSignal
      /** Main-internal, never on the wire: see `TerminalWaiter.launchReadiness`. */
      launchReadiness?: boolean
    }
  ): Promise<RuntimeTerminalWaitResult> {
    const condition = options?.condition ?? 'exit'
    const { pty } = this.deps.getTerminalPty(handle)
    if (condition === 'exit' && !pty.connected && !this.deps.exitUnsettled(pty)) {
      return buildPtyTerminalWaitResult(handle, condition, pty)
    }
    const waitText = buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
    // Only strong verdicts settle synchronously; weak evidence needs the poll's rendered-screen check.
    const verdict = condition === 'tui-idle' ? this.evaluate(pty, waitText) : null
    if (verdict?.kind === 'blocked') {
      return buildPtyTerminalWaitBlockedResult(handle, condition, pty, verdict.reason)
    }
    if (verdict?.kind === 'ready-strong') {
      return buildPtyTerminalWaitResult(handle, condition, pty)
    }
    return await new Promise<RuntimeTerminalWaitResult>((resolve, reject) => {
      // Bound unsupported-agent waits so missing OSC classification cannot hang forever.
      const effectiveTimeoutMs =
        typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
          ? options.timeoutMs
          : condition === 'tui-idle'
            ? this.deps.defaultTimeoutMs
            : 0
      const waiter: TerminalWaiter = {
        handle,
        ptyId: pty.ptyId,
        condition,
        resolve,
        reject,
        timeout: null,
        cancelIdlePoll: null,
        abortCleanup: null,
        ...(options?.launchReadiness ? { launchReadiness: true } : {})
      }
      if (!this.waiters.bindAbort(waiter, options?.signal)) {
        reject(new Error('request_aborted'))
        return
      }
      if (effectiveTimeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          this.waiters.remove(waiter)
          reject(new Error('timeout'))
        }, effectiveTimeoutMs)
      }
      this.waiters.add(waiter)
      if (verdict) {
        // Ready previews can precede idle OSC titles; keep polling both.
        this.polls.start(waiter, pty, verdict)
        const paneAgent = this.deps.getPaneAgent(pty.ptyId)
        if (shouldProbeVisibleScreen(paneAgent, pty, outputClockOf(this.deps, pty), waitText)) {
          this.deps.startVisibleReadProbe(waiter, effectiveTimeoutMs, paneAgent)
        }
      }
    })
  }
}
