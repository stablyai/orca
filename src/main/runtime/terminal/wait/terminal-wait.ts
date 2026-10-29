import type {
  RuntimeTerminalWait as RuntimeTerminalWaitResult,
  RuntimeTerminalWaitCondition
} from '../../../../shared/runtime-terminal-contracts'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult,
  buildTerminalWaitBlockedResult,
  buildTerminalWaitResult,
  getTerminalState
} from '../../terminal-wait-results'
import { readsTrustedScreen } from '../../agent-state-rules/agent-state-rules-engine'
import { showsScreenProbeBanner } from '../../agent-state-rules/agent-state-text-anchors'
import { buildTerminalWaitText } from '../../terminal-wait-tail-state'
import { evaluateTuiIdle, type TuiIdleVerdict } from '../../tui-idle-evidence'
import {
  leafTuiIdleEvidence,
  ptyTuiIdleEvidence,
  type TuiIdleEvidenceSource
} from '../../tui-idle-evidence-source'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { TerminalWaiter } from '../../runtime-terminal-contracts'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type { RuntimeTerminalIdlePolls } from './terminal-idle-polls'
import type { RuntimeTerminalWaiterRegistry } from './terminal-waiter-registry'

/** Probe unseen/provider-only panes and clockless screen-ruled agents with untrusted restored models; clocked panes settle through quiet polling. profile.screenProbeBanner also opts in. */
function shouldProbeVisibleScreen(
  paneAgent: TuiAgent | null,
  record: Pick<RuntimePtyWorktreeRecord, 'lastAgentStatus' | 'lastOutputAt'>,
  waitText: string
): boolean {
  return (
    (record.lastAgentStatus === null && waitText.length === 0) ||
    showsScreenProbeBanner(waitText) ||
    (readsTrustedScreen(paneAgent) && record.lastOutputAt === null)
  )
}

type RuntimeTerminalWaitDependencies = TuiIdleEvidenceSource & {
  defaultTimeoutMs: number
  getLivePty(handle: string): { pty: RuntimePtyWorktreeRecord } | null
  /** A disconnected terminal that may still run, so an exit wait keeps waiting for its end. */
  exitUnsettled(pty: RuntimePtyWorktreeRecord): boolean
  getLiveLeaf(handle: string): { leaf: RuntimeLeafRecord }
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

  /** Why one helper per record kind: every satisfaction site must rank the same way,
   *  or the immediate check and the poll disagree about the same pane. */
  private evaluatePty(pty: RuntimePtyWorktreeRecord, waitText: string): TuiIdleVerdict {
    return evaluateTuiIdle(ptyTuiIdleEvidence(this.deps, pty, () => waitText))
  }

  private evaluateLeaf(leaf: RuntimeLeafRecord, waitText: string): TuiIdleVerdict {
    return evaluateTuiIdle(leafTuiIdleEvidence(this.deps, leaf, () => waitText))
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
    const pty = this.deps.getLivePty(handle)
    if (pty) {
      if (condition === 'exit' && !pty.pty.connected && !this.deps.exitUnsettled(pty.pty)) {
        return buildPtyTerminalWaitResult(handle, condition, pty.pty)
      }
      const ptyWaitText = buildTerminalWaitText(
        pty.pty.tailBuffer,
        pty.pty.tailPartialLine,
        pty.pty.preview
      )
      // Only strong verdicts settle synchronously; weak evidence needs the poll's rendered-screen check.
      const ptyVerdict = condition === 'tui-idle' ? this.evaluatePty(pty.pty, ptyWaitText) : null
      if (ptyVerdict?.kind === 'blocked') {
        return buildPtyTerminalWaitBlockedResult(handle, condition, pty.pty, ptyVerdict.reason)
      }
      if (ptyVerdict?.kind === 'ready-strong') {
        return buildPtyTerminalWaitResult(handle, condition, pty.pty)
      }
      return await new Promise<RuntimeTerminalWaitResult>((resolve, reject) => {
        const effectiveTimeoutMs =
          typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
            ? options.timeoutMs
            : condition === 'tui-idle'
              ? this.deps.defaultTimeoutMs
              : 0
        const waiter: TerminalWaiter = {
          handle,
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
        const live = this.deps.getLivePty(handle)
        if (!live) {
          this.waiters.remove(waiter)
          reject(new Error('terminal_handle_stale'))
        } else if (
          condition === 'exit' &&
          !live.pty.connected &&
          !this.deps.exitUnsettled(live.pty)
        ) {
          this.waiters.resolve(waiter, buildPtyTerminalWaitResult(handle, condition, live.pty))
        } else if (condition === 'tui-idle') {
          const livePtyWaitText = buildTerminalWaitText(
            live.pty.tailBuffer,
            live.pty.tailPartialLine,
            live.pty.preview
          )
          const verdict = this.evaluatePty(live.pty, livePtyWaitText)
          if (verdict.kind === 'blocked') {
            this.waiters.resolve(
              waiter,
              buildPtyTerminalWaitBlockedResult(handle, condition, live.pty, verdict.reason)
            )
          } else if (verdict.kind === 'ready-strong') {
            this.waiters.resolve(waiter, buildPtyTerminalWaitResult(handle, condition, live.pty))
          } else {
            this.polls.startPty(waiter, live.pty, verdict)
            const paneAgent = this.deps.getPaneAgent(live.pty.ptyId)
            if (shouldProbeVisibleScreen(paneAgent, live.pty, livePtyWaitText)) {
              this.deps.startVisibleReadProbe(waiter, effectiveTimeoutMs, paneAgent)
            }
          }
        }
      })
    }
    const { leaf } = this.deps.getLiveLeaf(handle)
    if (condition === 'exit' && getTerminalState(leaf) === 'exited') {
      return buildTerminalWaitResult(handle, condition, leaf)
    }

    const leafWaitText = buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
    const leafVerdict = condition === 'tui-idle' ? this.evaluateLeaf(leaf, leafWaitText) : null
    if (leafVerdict?.kind === 'blocked') {
      return buildTerminalWaitBlockedResult(handle, condition, leaf, leafVerdict.reason)
    }

    // Strong rest can satisfy before waiter registration; permission is user-blocked, not task completion.
    if (leafVerdict?.kind === 'ready-strong') {
      return buildTerminalWaitResult(handle, condition, leaf)
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

      // Revalidate after waiter registration to catch handle replacement or exit in the gap.
      try {
        const live = this.deps.getLiveLeaf(handle)
        if (getTerminalState(live.leaf) === 'exited') {
          this.waiters.resolve(waiter, buildTerminalWaitResult(handle, condition, live.leaf))
        } else if (condition === 'tui-idle') {
          const liveLeafWaitText = buildTerminalWaitText(
            live.leaf.tailBuffer,
            live.leaf.tailPartialLine,
            live.leaf.preview
          )
          const verdict = this.evaluateLeaf(live.leaf, liveLeafWaitText)
          if (verdict.kind === 'blocked') {
            this.waiters.resolve(
              waiter,
              buildTerminalWaitBlockedResult(handle, condition, live.leaf, verdict.reason)
            )
          } else if (verdict.kind === 'ready-strong') {
            // Status is retained evidence, not a consumable signal; clearing idle strands subsequent waiters.
            this.waiters.resolve(waiter, buildTerminalWaitResult(handle, condition, live.leaf))
          } else {
            // Ready previews can precede idle OSC titles; keep polling both.
            this.polls.startLeaf(waiter, live.leaf, verdict)
            const paneAgent = this.deps.getPaneAgent(live.leaf.ptyId)
            if (shouldProbeVisibleScreen(paneAgent, live.leaf, liveLeafWaitText)) {
              this.deps.startVisibleReadProbe(waiter, effectiveTimeoutMs, paneAgent)
            }
          }
        }
      } catch (error) {
        this.waiters.remove(waiter)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
