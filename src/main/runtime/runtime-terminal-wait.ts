import type {
  RuntimeTerminalWait as RuntimeTerminalWaitResult,
  RuntimeTerminalWaitCondition
} from '../../shared/runtime-types'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult,
  buildTerminalWaitBlockedResult,
  buildTerminalWaitResult,
  getTerminalState
} from './terminal-wait-results'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import type { FirstPartyAgentStatus } from './tui-idle-evidence'
import type { TuiAgent } from '../../shared/tui-agent'
import type { TerminalWaiter } from './runtime-terminal-contracts'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { AgentStatus } from '../../shared/agent-detection'
import type { RuntimeTerminalIdlePolls } from './runtime-terminal-idle-polls'
import { RuntimeTerminalWaitEvidence } from './runtime-terminal-wait-evidence'
import {
  resolveLeafTuiIdleTimeout,
  resolvePtyTuiIdleTimeout
} from './runtime-terminal-wait-timeouts'
import type { RuntimeTerminalWaiterRegistry } from './runtime-terminal-waiter-registry'

type RuntimeTerminalWaitDependencies = {
  defaultTimeoutMs: number
  getLivePty(handle: string): { pty: RuntimePtyWorktreeRecord } | null
  getLiveLeaf(handle: string): { leaf: RuntimeLeafRecord }
  getAdoptedPtyIdleStatus(pty: RuntimePtyWorktreeRecord): AgentStatus | null
  getAdoptedPtyTitle?(pty: RuntimePtyWorktreeRecord): string | null
  getTabTitle(tabId: string): string | null
  getPaneAgent(ptyId: string | null | undefined): TuiAgent | null
  getFirstPartyAgentStatus(ptyId: string | null | undefined): FirstPartyAgentStatus
  getAttachmentId?(ptyId: string | null | undefined): string | null
  getTerminalProcessIncarnation(handle: string): string | null
  startVisibleReadProbe(waiter: TerminalWaiter, waiterTimeoutMs: number): void
}

export class RuntimeTerminalWait {
  private readonly evidence: RuntimeTerminalWaitEvidence

  constructor(
    private readonly deps: RuntimeTerminalWaitDependencies,
    private readonly waiters: RuntimeTerminalWaiterRegistry,
    private readonly polls: RuntimeTerminalIdlePolls
  ) {
    this.evidence = new RuntimeTerminalWaitEvidence(deps)
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
      const ptyEvidenceCursor =
        condition === 'tui-idle' ? this.evidence.capturePty(pty.pty) : undefined
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
      // No cursor here, deliberately: the fence exists so a DEFERRED decision cannot settle on
      // evidence that predates this operation. This read is the operation, and an already-idle
      // agent's evidence necessarily predates it — fencing it against a snapshot of itself asks
      // for a transition that already happened and can never arrive, so the wait times out on a
      // terminal that was idle the whole time.
      if (condition === 'tui-idle' && this.evidence.isPtySatisfied(pty.pty, ptyWaitText)) {
        return buildPtyTerminalWaitResult(
          handle,
          condition,
          pty.pty,
          this.evidence.result(this.evidence.observePty(pty.pty, ptyWaitText))
        )
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
          processIncarnation: this.deps.getTerminalProcessIncarnation(handle),
          ...(ptyEvidenceCursor ? { evidenceCursor: ptyEvidenceCursor } : {}),
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
            if (condition !== 'tui-idle') {
              reject(new Error('timeout'))
              return
            }
            resolvePtyTuiIdleTimeout(
              handle,
              resolve,
              reject,
              this.deps,
              this.evidence,
              waiter.evidenceCursor,
              waiter.processIncarnation
            )
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
          } else if (
            this.evidence.isPtySatisfied(live.pty, livePtyWaitText, waiter.evidenceCursor)
          ) {
            this.waiters.resolve(
              waiter,
              buildPtyTerminalWaitResult(
                handle,
                condition,
                live.pty,
                this.evidence.result(
                  this.evidence.observePty(live.pty, livePtyWaitText, waiter.evidenceCursor)
                )
              )
            )
          } else {
            this.polls.startPty(waiter, live.pty)
            // A fresh screen capture can prove an unchanged ready CLI even when
            // retained stream text is non-empty; generic bytes still never count
            // as readiness without the provider's positive matcher.
            if (
              live.pty.lastAgentStatus !== 'working' &&
              live.pty.lastAgentStatus !== 'permission'
            ) {
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
    const leafEvidenceCursor =
      condition === 'tui-idle' ? this.evidence.captureLeaf(leaf) : undefined
    // Unfenced for the same reason as the PTY read above: this synchronous look IS the operation,
    // so requiring evidence newer than it would reject the already-idle case it exists to catch.
    if (condition === 'tui-idle' && this.evidence.isLeafSatisfied(leaf, leafWaitText)) {
      return buildTerminalWaitResult(
        handle,
        condition,
        leaf,
        this.evidence.result(this.evidence.observeLeaf(leaf, leafWaitText))
      )
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
        processIncarnation: this.deps.getTerminalProcessIncarnation(handle),
        ...(leafEvidenceCursor ? { evidenceCursor: leafEvidenceCursor } : {}),
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
          if (condition !== 'tui-idle') {
            reject(new Error('timeout'))
            return
          }
          resolveLeafTuiIdleTimeout(
            handle,
            resolve,
            reject,
            this.deps,
            this.evidence,
            waiter.evidenceCursor,
            waiter.processIncarnation
          )
        }, effectiveTimeoutMs)
      }

      this.waiters.add(waiter)

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
          } else if (
            this.evidence.isLeafSatisfied(live.leaf, liveLeafWaitText, waiter.evidenceCursor)
          ) {
            this.waiters.resolve(
              waiter,
              buildTerminalWaitResult(
                handle,
                condition,
                live.leaf,
                this.evidence.result(
                  this.evidence.observeLeaf(live.leaf, liveLeafWaitText, waiter.evidenceCursor)
                )
              )
            )
          } else {
            this.polls.startLeaf(waiter, live.leaf)
            if (
              live.leaf.lastAgentStatus !== 'working' &&
              live.leaf.lastAgentStatus !== 'permission'
            ) {
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
