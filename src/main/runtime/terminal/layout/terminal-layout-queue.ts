import { OrcaRuntimeWithReclaimTerminalForDesktop } from './terminal-desktop-reclaim'
import type { ApplyLayoutResult, PtyLayoutState, PtyLayoutTarget } from '../../orca-runtime-core'

export abstract class OrcaRuntimeWithPickMostRecentActor extends OrcaRuntimeWithReclaimTerminalForDesktop {
  protected abstract applyLayout(ptyId: string, target: PtyLayoutTarget): Promise<ApplyLayoutResult>

  // Most-recent mobile actor owns phone-fit dimensions (docs/mobile-presence-lock.md).
  protected pickMostRecentActor(
    inner: Map<string, { clientId: string; lastActedAt: number }>
  ): { clientId: string; lastActedAt: number } | null {
    let best: { clientId: string; lastActedAt: number } | null = null
    for (const sub of inner.values()) {
      if (best === null || sub.lastActedAt > best.lastActedAt) {
        best = sub
      }
    }
    return best
  }

  // Restore from the earliest subscriber with a non-null baseline; passive desktop joins captured none.
  protected pickEarliestRestoreTarget(
    inner: Map<
      string,
      { subscribedAt: number; previousCols: number | null; previousRows: number | null }
    >
  ): { previousCols: number; previousRows: number } | null {
    let best: { subscribedAt: number; previousCols: number; previousRows: number } | null = null
    for (const sub of inner.values()) {
      if (sub.previousCols == null || sub.previousRows == null) {
        continue
      }
      if (best === null || sub.subscribedAt < best.subscribedAt) {
        best = {
          subscribedAt: sub.subscribedAt,
          previousCols: sub.previousCols,
          previousRows: sub.previousRows
        }
      }
    }
    return best ? { previousCols: best.previousCols, previousRows: best.previousRows } : null
  }

  // applyLayout owns layout, fit overrides and PTY resize, except dead-PTY cleanup deletes.
  // Serialize all triggers through enqueueLayout so resize awaits cannot reorder wire seq (docs/mobile-terminal-layout-state-machine.md).

  getLayout(ptyId: string): PtyLayoutState | null {
    return this.layouts.get(ptyId) ?? null
  }

  // First subscribe must pass the missing-entry guard before creating its layout.
  protected isFreshSubscribe(ptyId: string): boolean {
    return this.freshSubscribeGuard.has(ptyId)
  }

  // Keep restore fallback order in one place to prevent caller drift; 80x24 is the last resort.
  protected resolveDesktopRestoreTarget(ptyId: string): { cols: number; rows: number } {
    const inner = this.mobileSubscribers.get(ptyId)
    if (inner) {
      const earliest = this.pickEarliestRestoreTarget(inner)
      if (earliest) {
        return { cols: earliest.previousCols, rows: earliest.previousRows }
      }
    }
    const renderer = this.lastRendererSizes.get(ptyId)
    if (renderer) {
      return { cols: renderer.cols, rows: renderer.rows }
    }
    const size = this.getTerminalSize(ptyId)
    if (size) {
      return { cols: size.cols, rows: size.rows }
    }
    return { cols: 80, rows: 24 }
  }

  // Coalesce viewport ticks only for the same kind/owner; append mode, floor and owner changes to preserve fairness.
  protected coalescesWith(prev: PtyLayoutTarget, next: PtyLayoutTarget): boolean {
    if (prev.kind !== next.kind) {
      return false
    }
    if (prev.kind === 'phone' && next.kind === 'phone') {
      return prev.ownerClientId === next.ownerClientId
    }
    if (prev.kind === 'remote-desktop' && next.kind === 'remote-desktop') {
      // Why: each owner's claim promise gates its following input. Sharing a
      // waiter across owners could release A's input only after B's grid lands.
      return prev.ownerSubscriptionKey === next.ownerSubscriptionKey
    }
    return true
  }

  protected enqueueLayout(ptyId: string, target: PtyLayoutTarget): Promise<ApplyLayoutResult> {
    // Missing layout means exit unless this is the first subscribe transition.
    if (!this.layouts.has(ptyId) && !this.isFreshSubscribe(ptyId)) {
      return Promise.resolve({ ok: false, reason: 'pty-exited' })
    }

    let entry = this.layoutQueues.get(ptyId)
    if (!entry) {
      entry = { running: null, pending: [] }
      this.layoutQueues.set(ptyId, entry)
    }
    const queue = entry

    return new Promise<ApplyLayoutResult>((resolve) => {
      if (!queue.running) {
        queue.running = this.runLayoutSlot(ptyId, target, [resolve])
        return
      }
      const tail = queue.pending.at(-1)
      if (tail && this.coalescesWith(tail.target, target)) {
        tail.target = target
        tail.waiters.push(resolve)
        return
      }
      queue.pending.push({ target, waiters: [resolve] })
    })
  }

  protected async runLayoutSlot(
    ptyId: string,
    target: PtyLayoutTarget,
    waiters: ((r: ApplyLayoutResult) => void)[]
  ): Promise<ApplyLayoutResult> {
    let result: ApplyLayoutResult
    try {
      result = await this.applyLayout(ptyId, target)
    } catch (err) {
      // Synchronous notifier/map failures must not jam the queue even though applyLayout already catches resize errors.
      console.error('[layout] applyLayout threw', { ptyId, err })
      result = { ok: false, reason: 'resize-failed' }
    }
    for (const w of waiters) {
      w(result)
    }

    const queue = this.layoutQueues.get(ptyId)
    if (!queue) {
      return result
    }
    const next = queue.pending.shift()
    if (next) {
      queue.running = this.runLayoutSlot(ptyId, next.target, next.waiters)
    } else {
      queue.running = null
      // Drop empty queues so short-lived PTYs do not accumulate entries.
      this.layoutQueues.delete(ptyId)
    }
    return result
  }
}
