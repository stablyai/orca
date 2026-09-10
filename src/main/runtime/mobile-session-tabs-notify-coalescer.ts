// Why: spinner-in-title agents (e.g. the Claude Code braille spinner) flip a
// PTY title several times per second. Each flip touched every session.tabs
// snapshot and fanned a fresh emit out to every subscriber, where the ws layer
// JSON.stringifies it per client — O(clients × snapshot size) of churn work
// with no debounce. Clients gate on snapshotVersion freshness, so only the
// newest version per worktree matters; coalescing the intermediate emits is
// safe. Structural changes (tab added/removed/activated) bypass this via an
// immediate flush so they still propagate promptly.

import {
  createKeyedTrailingEdgeCoalescer,
  type KeyedTrailingEdgeCoalescer
} from './keyed-trailing-edge-coalescer'

// Trailing-edge window: title/status is latency-sensitive UI, so this is
// tighter than files.watch's 150ms but looser than native-chat's 40ms.
const SESSION_TABS_FLUSH_MS = 50
// Force a flush after this long even under sustained churn, so a title that
// keeps spinning never starves the emit indefinitely.
const SESSION_TABS_MAX_WAIT_MS = 250

/** Keys are worktree ids; `emit` reads the latest snapshot for the worktree itself. */
export type MobileSessionTabsNotifyCoalescer = KeyedTrailingEdgeCoalescer

/**
 * Coalesces per-worktree session.tabs notifications on a short trailing-edge
 * window. `emit` is invoked once per settled worktree and is expected to read
 * the latest snapshot itself, so only the freshest snapshotVersion is ever
 * published — dropped intermediate versions are exactly what clients discard.
 */
export function createMobileSessionTabsNotifyCoalescer(
  emit: (worktreeId: string) => void
): MobileSessionTabsNotifyCoalescer {
  return createKeyedTrailingEdgeCoalescer(emit, {
    flushMs: SESSION_TABS_FLUSH_MS,
    maxWaitMs: SESSION_TABS_MAX_WAIT_MS
  })
}
