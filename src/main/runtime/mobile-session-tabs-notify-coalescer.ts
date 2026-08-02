// Why: spinner-in-title agents (e.g. the Claude Code braille spinner) flip a
// PTY title several times per second. Each flip touched every session.tabs
// snapshot and fanned a fresh emit out to every subscriber, where the ws layer
// JSON.stringifies it per client — O(clients × snapshot size) of churn work
// with no debounce. Clients gate on snapshotVersion freshness, so only the
// newest version per worktree matters; coalescing the intermediate emits is
// safe. Structural changes (tab added/removed/activated) bypass this via an
// immediate flush so they still propagate promptly.

// Trailing-edge window: title/status is latency-sensitive UI, so this is
// tighter than files.watch's 150ms but looser than native-chat's 40ms.
const SESSION_TABS_FLUSH_MS = 50
// Force a flush after this long even under sustained churn, so a title that
// keeps spinning never starves the emit indefinitely.
const SESSION_TABS_MAX_WAIT_MS = 250

export type MobileSessionTabsNotifyCoalescer = {
  // Schedule a coalesced (trailing-edge) notify for a worktree.
  schedule: (worktreeId: string) => void
  // Cancel any pending notify for a worktree without emitting. Use when an
  // immediate emit has already superseded the pending state, or the worktree
  // was removed and a stale notify must not fire.
  cancel: (worktreeId: string) => void
  // Flush a worktree's pending notify now (emit if one is pending).
  flush: (worktreeId: string) => void
  // Flush every pending worktree now.
  flushAll: () => void
  // Drop all pending state without emitting (runtime teardown).
  dispose: () => void
}

type PendingNotify = {
  timer: ReturnType<typeof setTimeout>
  firstScheduledAt: number
}

/**
 * Coalesces per-worktree session.tabs notifications on a short trailing-edge
 * window. `emit` is invoked once per settled worktree and is expected to read
 * the latest snapshot itself, so only the freshest snapshotVersion is ever
 * published — dropped intermediate versions are exactly what clients discard.
 */
export function createMobileSessionTabsNotifyCoalescer(
  emit: (worktreeId: string) => void
): MobileSessionTabsNotifyCoalescer {
  const pending = new Map<string, PendingNotify>()

  const clear = (worktreeId: string): void => {
    const entry = pending.get(worktreeId)
    if (!entry) {
      return
    }
    clearTimeout(entry.timer)
    pending.delete(worktreeId)
  }

  const fire = (worktreeId: string): void => {
    clear(worktreeId)
    emit(worktreeId)
  }

  const arm = (worktreeId: string): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => fire(worktreeId), SESSION_TABS_FLUSH_MS)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    return timer
  }

  return {
    schedule(worktreeId: string): void {
      const now = Date.now()
      const existing = pending.get(worktreeId)
      if (existing) {
        // Cap total delay so sustained churn can't starve the emit forever.
        if (now - existing.firstScheduledAt >= SESSION_TABS_MAX_WAIT_MS) {
          fire(worktreeId)
          return
        }
        clearTimeout(existing.timer)
        existing.timer = arm(worktreeId)
        return
      }
      pending.set(worktreeId, { timer: arm(worktreeId), firstScheduledAt: now })
    },
    cancel(worktreeId: string): void {
      clear(worktreeId)
    },
    flush(worktreeId: string): void {
      if (pending.has(worktreeId)) {
        fire(worktreeId)
      }
    },
    flushAll(): void {
      // Snapshot keys first: fire() deletes from `pending`, and emit may
      // schedule new work, so mutating the live map mid-iteration is unsafe.
      const worktreeIds = Array.from(pending.keys())
      for (const worktreeId of worktreeIds) {
        fire(worktreeId)
      }
    },
    dispose(): void {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
      }
      pending.clear()
    }
  }
}
