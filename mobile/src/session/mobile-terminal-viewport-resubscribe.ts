// Bound nonconverging viewport refits to avoid stream churn, broken gestures and battery drain.

import type { TerminalFrame } from '../terminal/terminal-webview-messages'
import { translate } from '../i18n/mobile-i18n'
import type { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'

export const MAX_TERMINAL_VIEWPORT_RESUBSCRIBE_ATTEMPTS = 3

// First fit is immediate to teach the host the viewport; decay retries when dimensions still disagree.
const TERMINAL_VIEWPORT_RESUBSCRIBE_BACKOFF_MS = [0, 750, 3000] as const

export type TerminalViewportDims = { readonly cols: number; readonly rows: number }

function readPositiveDimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function readTerminalViewportDims(data: Readonly<Record<string, unknown>>): {
  readonly hostCols: number | null
  readonly hostRows: number | null
} {
  return {
    hostCols: readPositiveDimension(data.cols),
    hostRows: readPositiveDimension(data.rows)
  }
}

export type TerminalViewportResubscribeDecision =
  | { readonly kind: 'resubscribe'; readonly delayMs: number }
  | { readonly kind: 'converged' }
  | { readonly kind: 'hold' }
  | { readonly kind: 'exhausted' }

function resubscribeDelayMs(attempts: number): number {
  return TERMINAL_VIEWPORT_RESUBSCRIBE_BACKOFF_MS[
    Math.min(attempts, TERMINAL_VIEWPORT_RESUBSCRIBE_BACKOFF_MS.length - 1)
  ]
}

export function resolveTerminalViewportResubscribe(args: {
  hostCols: number | null
  hostRows: number | null
  viewportMeasured: boolean
  viewport: TerminalViewportDims | null
  attempts: number
  displayMode?: string | null
}): TerminalViewportResubscribeDecision {
  // Desktop mode intentionally keeps desktop dimensions; phone mismatch is not fit failure.
  if (args.displayMode === 'desktop') {
    return { kind: 'converged' }
  }
  const overBudget = args.attempts >= MAX_TERMINAL_VIEWPORT_RESUBSCRIBE_ATTEMPTS
  // First subscribe carries no viewport; resubscribing is how the server learns it.
  if (!args.viewportMeasured || args.viewport == null) {
    return overBudget ? { kind: 'exhausted' } : { kind: 'resubscribe', delayMs: 0 }
  }
  // Hosts omitting PTY dimensions cannot converge; retain their stream instead of replaying the same frame.
  if (args.hostCols == null || args.hostRows == null) {
    return { kind: 'hold' }
  }
  if (args.hostCols === args.viewport.cols && args.hostRows === args.viewport.rows) {
    return { kind: 'converged' }
  }
  return overBudget
    ? { kind: 'exhausted' }
    : { kind: 'resubscribe', delayMs: resubscribeDelayMs(args.attempts) }
}

// Recheck after measuring because cached viewport mismatch may already be resolved.
export function shouldResubscribeAfterViewportMeasure(args: {
  hostCols: number | null
  hostRows: number | null
  measured: TerminalViewportDims
  viewportWasMeasured: boolean
}): boolean {
  if (!args.viewportWasMeasured) {
    return true
  }
  return args.hostCols !== args.measured.cols || args.hostRows !== args.measured.rows
}

type RetryGenerationToken = Readonly<Record<string, never>>

// Refill only after a handle disappears and returns; ordinary list refreshes must not undo the retry bound.
export class TerminalViewportResubscribeBudget {
  private readonly attemptsByHandle = new Map<string, number>()
  private readonly absentSinceExhaustion = new Set<string>()
  private readonly announcedExhaustion = new Set<string>()
  private readonly retryGenerationByHandle = new Map<string, RetryGenerationToken>()

  attempts(handle: string): number {
    return this.attemptsByHandle.get(handle) ?? 0
  }

  chargeAttempt(handle: string): void {
    this.attemptsByHandle.set(handle, this.attempts(handle) + 1)
  }

  retryGeneration(handle: string): RetryGenerationToken {
    const existing = this.retryGenerationByHandle.get(handle)
    if (existing) {
      return existing
    }
    const generation: RetryGenerationToken = {}
    this.retryGenerationByHandle.set(handle, generation)
    return generation
  }

  isRetryGenerationCurrent(handle: string, generation: RetryGenerationToken): boolean {
    return this.retryGenerationByHandle.get(handle) === generation
  }

  observeResize(
    handle: string,
    data: Readonly<Record<string, unknown>>,
    viewport: TerminalViewportDims | null
  ): readonly [number, number] {
    const { hostCols, hostRows } = readTerminalViewportDims(data)
    const cols = hostCols ?? 80
    const rows = hostRows ?? 24
    if (viewport?.cols === cols && viewport.rows === rows) {
      this.markConverged(handle)
    }
    return [cols, rows]
  }

  markConverged(handle: string): void {
    this.forget(handle)
  }

  shouldAnnounceExhaustion(handle: string): boolean {
    if (this.announcedExhaustion.has(handle)) {
      return false
    }
    this.announcedExhaustion.add(handle)
    return true
  }

  notifyListedHandles(liveHandles: ReadonlySet<string>): void {
    for (const handle of Array.from(this.attemptsByHandle.keys())) {
      if (this.attempts(handle) < MAX_TERMINAL_VIEWPORT_RESUBSCRIBE_ATTEMPTS) {
        continue
      }
      if (!liveHandles.has(handle)) {
        this.absentSinceExhaustion.add(handle)
        continue
      }
      // Only reappearance after absence permits a fresh budget and exhaustion announcement.
      if (this.absentSinceExhaustion.delete(handle)) {
        this.forget(handle)
      }
    }
  }

  forget(handle: string): void {
    this.attemptsByHandle.delete(handle)
    this.absentSinceExhaustion.delete(handle)
    this.announcedExhaustion.delete(handle)
    this.retryGenerationByHandle.delete(handle)
  }

  clear(): void {
    this.attemptsByHandle.clear()
    this.absentSinceExhaustion.clear()
    this.announcedExhaustion.clear()
    this.retryGenerationByHandle.clear()
  }
}

export type MutableRef<T> = { current: T }

type TerminalFitWebView = {
  awaitReady: () => Promise<unknown>
  fitDimensions: (frame: { width: number; height: number }) => TerminalViewportDims | null
}

export type TerminalViewportFitPassArgs = {
  handle: string
  seq: number
  hostCols: number | null
  hostRows: number | null
  displayMode?: string | null
  sentViewport: TerminalViewportDims | null
  budget: TerminalViewportResubscribeBudget
  diagnostics: Pick<
    MobileTerminalDiagnostics,
    'streamResubscribing' | 'streamResubscribeHeld' | 'streamResubscribeExhausted'
  >
  viewportRef: MutableRef<TerminalViewportDims | null>
  viewportMeasuredRef: MutableRef<boolean>
  subscribeSeqRef: MutableRef<Map<string, number>>
  terminalUnsubsRef: MutableRef<Map<string, () => void>>
  terminalFrameRef: MutableRef<TerminalFrame | null>
  getTerminalRef: (handle: string | null) => TerminalFitWebView | undefined
  unsubscribeTerminal: (handle: string) => void
  subscribeToTerminal: (handle: string) => void
  scheduleDelayedAction: (fn: () => void, ms: number) => void
  showToast: (message: string, durationMs?: number) => void
}

export function runTerminalViewportFitPass(args: TerminalViewportFitPassArgs): void {
  const { handle, seq, hostCols, hostRows, budget, diagnostics } = args
  const retryGeneration = budget.retryGeneration(handle)
  const decision = resolveTerminalViewportResubscribe({
    hostCols,
    hostRows,
    displayMode: args.displayMode,
    viewportMeasured: args.viewportMeasuredRef.current,
    viewport: args.viewportRef.current,
    attempts: budget.attempts(handle)
  })
  if (decision.kind === 'converged') {
    budget.markConverged(handle)
    return
  }
  if (decision.kind === 'hold') {
    diagnostics.streamResubscribeHeld(handle, seq)
    return
  }
  if (decision.kind === 'exhausted') {
    diagnostics.streamResubscribeExhausted(handle, seq, budget.attempts(handle))
    if (budget.shouldAnnounceExhaustion(handle)) {
      args.showToast(
        translate(
          'session.terminalViewportResubscribe.fitFailed',
          "Couldn't fit the terminal to this screen"
        ),
        4000
      )
    }
    return
  }
  // A matching freshly measured viewport needs no new subscribe.
  const viewportWasMeasured = args.viewportMeasuredRef.current || args.sentViewport != null
  void (async () => {
    // Wait for init’s animation-frame chain to report the box used for fitting.
    await args.getTerminalRef(handle)?.awaitReady()
    if (
      args.subscribeSeqRef.current.get(handle) !== seq ||
      !budget.isRetryGenerationCurrent(handle, retryGeneration)
    ) {
      return
    }
    const frame = args.terminalFrameRef.current
    const dims = frame ? args.getTerminalRef(handle)?.fitDimensions(frame) : null
    if (!dims) {
      return
    }
    args.viewportRef.current = dims
    args.viewportMeasuredRef.current = true
    if (
      !shouldResubscribeAfterViewportMeasure({
        hostCols,
        hostRows,
        measured: dims,
        viewportWasMeasured
      })
    ) {
      budget.markConverged(handle)
      return
    }
    const resubscribe = (): void => {
      if (
        args.subscribeSeqRef.current.get(handle) !== seq ||
        !budget.isRetryGenerationCurrent(handle, retryGeneration)
      ) {
        return
      }
      if (!args.getTerminalRef(handle)) {
        return
      }
      diagnostics.streamResubscribing(handle, seq, dims, budget.attempts(handle), decision.delayMs)
      args.unsubscribeTerminal(handle)
      args.subscribeToTerminal(handle)
      // Only an armed subscribe spends budget; locally rejected attempts never reached the host.
      if (args.terminalUnsubsRef.current.has(handle)) {
        budget.chargeAttempt(handle)
      }
    }
    if (decision.delayMs > 0) {
      // Keep input live during backoff; tear down only when retry fires.
      args.scheduleDelayedAction(resubscribe, decision.delayMs)
    } else {
      resubscribe()
    }
  })()
}
