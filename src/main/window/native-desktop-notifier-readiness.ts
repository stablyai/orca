import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const MAX_BUFFERED_BROADCASTS_PER_WINDOW = 128

type PendingBroadcast = { method: string; args: unknown[] }

type WindowState = {
  ready: boolean
  /** Readiness to restore if the in-flight reload this fence belongs to is cancelled; null outside a fence. */
  fenceRestoreTo: boolean | null
  overflowed: boolean
  pending: PendingBroadcast[]
}

function newWindowState(): WindowState {
  return { ready: false, fenceRestoreTo: null, overflowed: false, pending: [] }
}

/**
 * Tracks whether each native desktop window's renderer has proven its runtime
 * notification listeners are mounted (see `runtime:notifierReady`), and holds
 * the broadcasts a not-yet-ready window missed so it can replay them once
 * ready. Bounded per window; cleared on close/crash/cancel so nothing outlives
 * the window.
 */
export class NativeDesktopNotifierReadiness {
  private readonly windows = new Map<number, WindowState>()

  isReady(windowId: number): boolean {
    return this.windows.get(windowId)?.ready === true
  }

  needsRecovery(windowId: number): boolean {
    return this.windows.get(windowId)?.overflowed === true
  }

  settleRecovery(windowId: number): void {
    this.windows.set(windowId, newWindowState())
  }

  /** The renderer pinged readiness; returns what it missed without clearing it (see `settleFlush`). */
  markReady(windowId: number): readonly PendingBroadcast[] {
    const state = this.windows.get(windowId) ?? newWindowState()
    state.ready = true
    if (state.fenceRestoreTo !== null) {
      state.fenceRestoreTo = true
    }
    this.windows.set(windowId, state)
    return state.pending
  }

  /**
   * Clears exactly the pending broadcasts a caller has finished delivering (by reference
   * identity), so a flush that could not run (e.g. the sender was still unavailable) leaves
   * them queued for the next ready signal instead of losing them.
   */
  settleFlush(windowId: number, delivered: readonly PendingBroadcast[]): void {
    const state = this.windows.get(windowId)
    if (state && state.pending === delivered) {
      state.pending = []
    }
  }

  /**
   * A genuine new document is replacing the old one (reload past the point of cancellation, a
   * crash, or a close); its listeners are gone until it pings again. Any open fence is dropped —
   * a later cancellation report for the document this superseded must not resurrect it.
   */
  markUnready(windowId: number): void {
    const state = this.windows.get(windowId) ?? newWindowState()
    state.ready = false
    state.fenceRestoreTo = null
    this.windows.set(windowId, state)
  }

  /** A reload fence opened; remember whether this window was ready so a cancel can restore it exactly. */
  beginReloadFence(windowId: number): void {
    const state = this.windows.get(windowId) ?? newWindowState()
    state.fenceRestoreTo = state.ready
    state.ready = false
    this.windows.set(windowId, state)
  }

  /** The provisional reload was cancelled; the surviving document's prior readiness is restored as-is. */
  restoreReady(windowId: number): readonly PendingBroadcast[] {
    const state = this.windows.get(windowId)
    const restoreTo = state?.fenceRestoreTo ?? false
    if (state) {
      state.ready = restoreTo
      state.fenceRestoreTo = null
    }
    return restoreTo ? this.markReady(windowId) : []
  }

  /** An incomplete replay requires a fresh document snapshot rather than a truncated suffix. */
  buffer(windowId: number, method: string, args: unknown[]): void {
    const state = this.windows.get(windowId) ?? newWindowState()
    if (!state.overflowed) {
      if (state.pending.length === MAX_BUFFERED_BROADCASTS_PER_WINDOW) {
        state.pending = []
        state.overflowed = true
      } else {
        state.pending.push({ method, args })
      }
    }
    this.windows.set(windowId, state)
  }

  /** The window closed, crashed, or unregistered; release all retained state. */
  forget(windowId: number): void {
    this.windows.delete(windowId)
  }
}

const readinessByRuntime = new WeakMap<OrcaRuntimeService, NativeDesktopNotifierReadiness>()

export function nativeDesktopNotifierReadiness(
  runtime: OrcaRuntimeService
): NativeDesktopNotifierReadiness {
  let readiness = readinessByRuntime.get(runtime)
  if (!readiness) {
    readiness = new NativeDesktopNotifierReadiness()
    readinessByRuntime.set(runtime, readiness)
  }
  return readiness
}
