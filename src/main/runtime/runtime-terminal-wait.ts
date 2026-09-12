import type {
  RuntimeTerminalWait as RuntimeTerminalWaitResult,
  RuntimeTerminalWaitCondition
} from '../../shared/runtime-types'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptPreview
} from './terminal-wait-detection'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult,
  buildTerminalWaitBlockedResult,
  buildTerminalWaitResult,
  getTerminalState
} from './terminal-wait-results'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import { isTuiIdleSatisfied, type FirstPartyAgentStatus } from './tui-idle-evidence'
import type { TuiAgent } from '../../shared/tui-agent'
import type { TerminalWaiter } from './runtime-terminal-contracts'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { AgentStatus } from '../../shared/agent-detection'
import type { RuntimeTerminalIdlePolls } from './runtime-terminal-idle-polls'
import type { RuntimeTerminalWaiterRegistry } from './runtime-terminal-waiter-registry'

type RuntimeTerminalWaitDependencies = {
  defaultTimeoutMs: number
  getLivePty(handle: string): { pty: RuntimePtyWorktreeRecord } | null
  getLiveLeaf(handle: string): { leaf: RuntimeLeafRecord }
  getAdoptedPtyIdleStatus(pty: RuntimePtyWorktreeRecord): AgentStatus | null
  getTabTitle(tabId: string): string | null
  quiescenceMs: number
  getPaneAgent(ptyId: string | null | undefined): TuiAgent | null
  getFirstPartyAgentStatus(ptyId: string | null | undefined): FirstPartyAgentStatus
  startVisibleReadProbe(waiter: TerminalWaiter, waiterTimeoutMs: number): void
}

export class RuntimeTerminalWait {
  constructor(
    private readonly deps: RuntimeTerminalWaitDependencies,
    private readonly waiters: RuntimeTerminalWaiterRegistry,
    private readonly polls: RuntimeTerminalIdlePolls
  ) {}

  /** Why one helper per record kind: every satisfaction site must rank the same way,
   *  or the immediate check and the poll disagree about the same pane. */
  private ptySatisfied(pty: RuntimePtyWorktreeRecord, waitText: string): boolean {
    return isTuiIdleSatisfied({
      record: pty,
      positiveBodyEvidence:
        this.deps.getAdoptedPtyIdleStatus(pty) === 'idle' || isKnownReadyPromptPreview(waitText),
      agent: this.deps.getPaneAgent(pty.ptyId),
      firstPartyStatus: this.deps.getFirstPartyAgentStatus(pty.ptyId),
      quiescenceMs: this.deps.quiescenceMs
    })
  }

  private leafSatisfied(leaf: RuntimeLeafRecord, waitText: string): boolean {
    return isTuiIdleSatisfied({
      record: leaf,
      rendererTitle: leaf.paneTitle ?? this.deps.getTabTitle(leaf.tabId),
      positiveBodyEvidence: isKnownReadyPromptPreview(waitText),
      agent: this.deps.getPaneAgent(leaf.ptyId),
      firstPartyStatus: this.deps.getFirstPartyAgentStatus(leaf.ptyId),
      quiescenceMs: this.deps.quiescenceMs
    })
  }

  async wait(
    handle: string,
    options?: {
      condition?: RuntimeTerminalWaitCondition
      timeoutMs?: number
      signal?: AbortSignal
    }
  ): Promise<RuntimeTerminalWaitResult> {
    const condition = options?.condition ?? 'exit'
    const pty = this.deps.getLivePty(handle)
    if (pty) {
      if (condition === 'exit' && !pty.pty.connected) {
        return buildPtyTerminalWaitResult(handle, condition, pty.pty)
      }
      const ptyWaitText = buildTerminalWaitText(
        pty.pty.tailBuffer,
        pty.pty.tailPartialLine,
        pty.pty.preview
      )
      const ptyBlockedReason = detectTerminalWaitBlockedReason(ptyWaitText)
      if (condition === 'tui-idle' && ptyBlockedReason) {
        return buildPtyTerminalWaitBlockedResult(handle, condition, pty.pty, ptyBlockedReason)
      }
      if (condition === 'tui-idle' && this.ptySatisfied(pty.pty, ptyWaitText)) {
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
          abortCleanup: null
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
        } else if (condition === 'exit' && !live.pty.connected) {
          this.waiters.resolve(waiter, buildPtyTerminalWaitResult(handle, condition, live.pty))
        } else if (condition === 'tui-idle') {
          const livePtyWaitText = buildTerminalWaitText(
            live.pty.tailBuffer,
            live.pty.tailPartialLine,
            live.pty.preview
          )
          const blockedReason = detectTerminalWaitBlockedReason(livePtyWaitText)
          if (blockedReason) {
            this.waiters.resolve(
              waiter,
              buildPtyTerminalWaitBlockedResult(handle, condition, live.pty, blockedReason)
            )
          } else if (this.ptySatisfied(live.pty, livePtyWaitText)) {
            this.waiters.resolve(waiter, buildPtyTerminalWaitResult(handle, condition, live.pty))
          } else {
            this.polls.startPty(waiter, live.pty)
            if (live.pty.lastAgentStatus === null && livePtyWaitText.length === 0) {
              this.deps.startVisibleReadProbe(waiter, effectiveTimeoutMs)
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
    const leafBlockedReason = detectTerminalWaitBlockedReason(leafWaitText)
    if (condition === 'tui-idle' && leafBlockedReason) {
      return buildTerminalWaitBlockedResult(handle, condition, leaf, leafBlockedReason)
    }

    // Why: if the agent already transitioned to idle (or permission) before the
    // waiter was registered, resolve immediately. This uses the same OSC title
    // detection that powers the renderer's "Task complete" notifications.
    // Why: only 'idle' satisfies tui-idle, not 'permission'. Permission means the
    // agent is blocked on user approval, not finished with its task.
    if (condition === 'tui-idle' && this.leafSatisfied(leaf, leafWaitText)) {
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
        abortCleanup: null
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
          const blockedReason = detectTerminalWaitBlockedReason(liveLeafWaitText)
          if (blockedReason) {
            this.waiters.resolve(
              waiter,
              buildTerminalWaitBlockedResult(handle, condition, live.leaf, blockedReason)
            )
          } else if (this.leafSatisfied(live.leaf, liveLeafWaitText)) {
            // Why: don't clear lastAgentStatus here. It's a factual record of the
            // last detected OSC state, not a one-shot signal. Clearing it causes
            // subsequent tui-idle waiters to hang even though the agent is idle —
            // the first waiter consumes the status and all later ones see null.
            this.waiters.resolve(waiter, buildTerminalWaitResult(handle, condition, live.leaf))
          } else {
            // Why: renderer-synced previews can show a known ready prompt even
            // while the last OSC title is still "working"; keep polling the
            // preview/title until the waiter resolves or hits its timeout.
            this.polls.startLeaf(waiter, live.leaf)
            if (live.leaf.lastAgentStatus === null && liveLeafWaitText.length === 0) {
              this.deps.startVisibleReadProbe(waiter, effectiveTimeoutMs)
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
