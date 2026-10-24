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

// Why 1s: it matches the provider visible-snapshot retry cadence, so a repainted screen is
// picked up on the next attempt without adding a second, faster sweep to the wait path.
const TUI_IDLE_VISIBLE_PROBE_RETRY_MS = 1_000

/**
 * Agents whose settled readiness is painted to the screen instead of written to scrollback.
 */
function usesAlternateScreenReadiness(agent: TuiAgent | null): boolean {
  return agent === 'antigravity' || agent === 'codex'
}

/**
 * A pane with no retained bytes and no status has only its provider's screen to read, and one
 * whose tail shows a rule file's `profile.screenProbeBanner` is probed as before screen rules. So
 * is a clockless pane whose rules read the trusted screen, whatever its status: a re-attached
 * pane's own model can be untrusted. A clocked one settles through the poll, once quiet.
 *
 * Alternate-screen agents join whatever their status: codex 0.157 turned on
 * `tui.fullscreen_transcript`, so the session banner is painted into the alternate screen with
 * cursor addressing instead of being written to scrollback, and `buildTerminalWaitText` only
 * ever reads the stream tail — a pane whose readiness lives on the screen never settles from
 * the tail alone (#22825).
 */
function shouldProbeVisibleScreen(
  paneAgent: TuiAgent | null,
  record: Pick<RuntimePtyWorktreeRecord, 'lastAgentStatus' | 'lastOutputAt'>,
  waitText: string
): boolean {
  return (
    usesAlternateScreenReadiness(paneAgent) ||
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

  /**
   * Ask the provider for its visible screen, repeating for the panes whose readiness the
   * stream tail can never carry.
   *
   * Why repeat instead of one bounded look: a launch registers the waiter while the TUI is
   * still painting, so a single probe can read a blank screen and hand the wait back to the
   * tail-only sweep, which cannot see an alternate-screen banner at all. Every other lane
   * settles from the tail, so those panes keep today's single bounded look and its cost.
   *
   * Why the timer rides on the waiter: the registry's single `remove` path then retires it
   * alongside the wait timeout and the idle poll, so no probe can outlive its waiter.
   */
  private startVisibleScreenProbe(
    waiter: TerminalWaiter,
    waiterTimeoutMs: number,
    agent: TuiAgent | null
  ): void {
    const deadlineAt = Date.now() + Math.max(0, waiterTimeoutMs)
    if (!usesAlternateScreenReadiness(agent)) {
      this.deps.startVisibleReadProbe(waiter, waiterTimeoutMs, agent)
      return
    }
    let timer: NodeJS.Timeout | null = null
    const cancel = (): void => {
      if (timer) {
        clearTimeout(timer)
      }
      waiter.cancelVisibleProbe = null
    }
    const probe = (): void => {
      this.deps.startVisibleReadProbe(waiter, Math.max(0, deadlineAt - Date.now()), agent)
      const remainingMs = deadlineAt - Date.now()
      // Why re-check: the probe can resolve synchronously, and `remove` has already retired
      // this loop by then, so arming another timer would outlive the waiter.
      if (remainingMs <= 0 || waiter.cancelVisibleProbe !== cancel) {
        return
      }
      timer = setTimeout(probe, Math.min(TUI_IDLE_VISIBLE_PROBE_RETRY_MS, remainingMs))
    }
    waiter.cancelVisibleProbe = cancel
    probe()
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
      // Why strong verdicts only, here and at every other synchronous site: weak evidence
      // cannot see a dialog the tail lost, so it settles only on the poll, after a screen read.
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
          cancelVisibleProbe: null,
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
              this.startVisibleScreenProbe(waiter, effectiveTimeoutMs, paneAgent)
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

    // Why: if the agent already announced rest before the waiter was registered, resolve
    // immediately. Only 'idle' satisfies tui-idle, not 'permission'. Permission means the
    // agent is blocked on user approval, not finished with its task.
    if (leafVerdict?.kind === 'ready-strong') {
      return buildTerminalWaitResult(handle, condition, leaf)
    }

    return await new Promise<RuntimeTerminalWaitResult>((resolve, reject) => {
      // Why: tui-idle depends on OSC title transitions from a recognized agent.
      // If no agent is detected, the waiter would hang forever. Enforce a default
      // timeout so unsupported CLIs fail predictably instead of silently blocking.
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
        cancelVisibleProbe: null,
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

      // Why: the handle may go stale or exit in the small gap between the first
      // validation and waiter registration. Re-checking here keeps wait --for
      // exit honest instead of hanging on a terminal that already changed.
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
            // Why: don't clear lastAgentStatus here. It's a factual record of the
            // last detected OSC state, not a one-shot signal. Clearing it causes
            // subsequent tui-idle waiters to hang even though the agent is idle —
            // the first waiter consumes the status and all later ones see null.
            this.waiters.resolve(waiter, buildTerminalWaitResult(handle, condition, live.leaf))
          } else {
            // Why: renderer-synced previews can show a known ready prompt even
            // while the last OSC title is still "working"; keep polling the
            // preview/title until the waiter resolves or hits its timeout.
            this.polls.startLeaf(waiter, live.leaf, verdict)
            const paneAgent = this.deps.getPaneAgent(live.leaf.ptyId)
            if (shouldProbeVisibleScreen(paneAgent, live.leaf, liveLeafWaitText)) {
              this.startVisibleScreenProbe(waiter, effectiveTimeoutMs, paneAgent)
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
