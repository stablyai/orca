/** Bounds the scrollback→measure→resubscribe fit loop (STA-3337): a host whose
 *  frame dims can never equal the phone viewport must not re-arm the stream
 *  forever — it broke gesture recognition and drained battery at ~25 cycles/s. */

import type { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'
import { t } from '@/i18n/mobile-i18n'

export const MAX_TERMINAL_VIEWPORT_RESUBSCRIBE_ATTEMPTS = 3

/** Attempt-indexed teardown delay. Attempt 0 is the ordinary first fit pass
 *  (server learns the viewport) and must stay immediate; later attempts mean
 *  the server answered with non-matching dims, so probe at a decaying rate. */
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
}): TerminalViewportResubscribeDecision {
  const overBudget = args.attempts >= MAX_TERMINAL_VIEWPORT_RESUBSCRIBE_ATTEMPTS
  // First subscribe carries no viewport; resubscribing is how the server learns it.
  if (!args.viewportMeasured || args.viewport == null) {
    return overBudget ? { kind: 'exhausted' } : { kind: 'resubscribe', delayMs: 0 }
  }
  // Why: a host that doesn't report PTY dims can never converge — resubscribing
  // replays the identical frame, so keep the stream instead of probing it.
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

/** Post-measure re-check: the pre-measure mismatch may have been a stale cached
 *  viewport. Resubscribing is only productive when the server still disagrees
 *  with the fresh measure, or was never told the viewport at all. */
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

/** Per-handle resubscribe budget, mirroring the chat-side rearm bound: attempts
 *  refill only when the handle actually left terminal.list and came back. A
 *  still-listed non-converging handle re-funded on every list refresh would undo
 *  the bound this class exists to enforce. */
export class TerminalViewportResubscribeBudget {
  private readonly attemptsByHandle = new Map<string, number>()
  private readonly absentSinceExhaustion = new Set<string>()
  private readonly announcedExhaustion = new Set<string>()
  private readonly retryGenerationByHandle = new Map<string, object>()

  attempts(handle: string): number {
    return this.attemptsByHandle.get(handle) ?? 0
  }

  chargeAttempt(handle: string): void {
    this.attemptsByHandle.set(handle, this.attempts(handle) + 1)
  }

  retryGeneration(handle: string): object {
    const existing = this.retryGenerationByHandle.get(handle)
    if (existing) {
      return existing
    }
    const generation = {}
    this.retryGenerationByHandle.set(handle, generation)
    return generation
  }

  isRetryGenerationCurrent(handle: string, generation: object): boolean {
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

  /** True exactly once per exhaustion so the degraded state is announced, not spammed. */
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
      // Why: only an absence marker buys a refill — the handle's PTY may be live
      // again, so a fresh budget (and a fresh degrade announcement) is warranted.
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

type MutableRef<T> = { current: T }

type TerminalFitWebView = {
  awaitReady: () => Promise<unknown>
  measureFitDimensions: (frameHeight?: number) => Promise<TerminalViewportDims | null | undefined>
}

export type TerminalViewportFitPassArgs = {
  handle: string
  seq: number
  hostCols: number | null
  hostRows: number | null
  budget: TerminalViewportResubscribeBudget
  diagnostics: Pick<
    MobileTerminalDiagnostics,
    'streamResubscribing' | 'streamResubscribeHeld' | 'streamResubscribeExhausted'
  >
  viewportRef: MutableRef<TerminalViewportDims | null>
  viewportMeasuredRef: MutableRef<boolean>
  subscribeSeqRef: MutableRef<Map<string, number>>
  initializedHandlesRef: MutableRef<Set<string>>
  terminalUnsubsRef: MutableRef<Map<string, () => void>>
  terminalFrameHeightRef: MutableRef<number>
  getTerminalRef: (handle: string | null) => TerminalFitWebView | undefined
  unsubscribeTerminal: (handle: string) => void
  subscribeToTerminal: (handle: string) => void
  scheduleDelayedAction: (fn: () => void, ms: number) => void
  showToast: (message: string, durationMs?: number) => void
}

/** One bounded fit pass per scrollback frame: converge, hold, degrade visibly,
 *  or measure and resubscribe (backing off) so the server can phone-fit. */
export function runTerminalViewportFitPass(args: TerminalViewportFitPassArgs): void {
  const { handle, seq, hostCols, hostRows, budget, diagnostics } = args
  const retryGeneration = budget.retryGeneration(handle)
  const decision = resolveTerminalViewportResubscribe({
    hostCols,
    hostRows,
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
      args.showToast(t('mobileTerminalViewportResubscribe.fitFailed'), 4000)
    }
    return
  }
  const viewportWasMeasured = args.viewportMeasuredRef.current
  void (async () => {
    // Why: wait for init()'s rAF chain before measuring, else the measure races ahead and returns null (log dump 2026-05-06).
    await args.getTerminalRef(handle)?.awaitReady()
    if (
      args.subscribeSeqRef.current.get(handle) !== seq ||
      !budget.isRetryGenerationCurrent(handle, retryGeneration)
    ) {
      return
    }
    const dims = await args
      .getTerminalRef(handle)
      ?.measureFitDimensions(args.terminalFrameHeightRef.current || undefined)
    // Why: re-check seq — the awaits may have let a newer subscribe cycle arm; tearing it down would resubscribe a stale generation.
    if (
      args.subscribeSeqRef.current.get(handle) !== seq ||
      !budget.isRetryGenerationCurrent(handle, retryGeneration)
    ) {
      return
    }
    if (!args.getTerminalRef(handle) || !dims) {
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
      // Why: the pre-measure mismatch was a stale cached viewport; the server already agrees.
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
      args.initializedHandlesRef.current.delete(handle)
      args.subscribeToTerminal(handle)
      // Why: only a resubscribe that actually armed spends budget; one turned away by its own gates never reached the host.
      if (args.terminalUnsubsRef.current.has(handle)) {
        budget.chargeAttempt(handle)
      }
    }
    if (decision.delayMs > 0) {
      // Why: keep the live stream up through the backoff so input keeps flowing; teardown happens only when the retry fires.
      args.scheduleDelayedAction(resubscribe, decision.delayMs)
    } else {
      resubscribe()
    }
  })()
}
