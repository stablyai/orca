import type { IPtyProvider } from './types'
import { isSshPtyNotFoundError } from './ssh-pty-provider'

/* Why: agent CLIs (Claude Code, Codex) buffer conversation transcript lines
 * and only flush at checkpoints. Killing their PTY with SIGKILL in the wrong
 * window persists eager metadata but drops the buffered conversation, leaving
 * an un-resumable session on disk. Every user-facing teardown path therefore
 * shuts down gracefully first (SIGTERM/SIGHUP or Windows taskkill /T inside
 * the provider), waits a bounded drain window for the process to exit on its
 * own, and only then escalates to a forced kill so nothing can hang forever. */

/** Bounded wait for a gracefully-shut-down PTY to exit before force-kill.
 *  Kept under the daemon/relay-internal 5s SIGKILL fallbacks so escalation
 *  here is deterministic rather than racing those timers. */
export const PTY_EXIT_DRAIN_WINDOW_MS = 3_000

/** Shorter drain bound for app quit and updater relaunch so quitting stays
 *  responsive; the leftover force-kill still runs before the process exits. */
export const APP_QUIT_PTY_DRAIN_MS = 2_000

export function isPtyAlreadyGoneError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return isSshPtyNotFoundError(err) || /Session not found/i.test(message)
}

/**
 * Shuts a PTY down gracefully, waits up to `drainWindowMs` for the provider
 * to report the exit, and escalates to an immediate (forced) shutdown on
 * timeout. Resolves only once the PTY is dead or force-killed, so callers
 * that delete files afterwards (worktree removal) keep a safe ordering.
 *
 * Returns whether the provider emitted its own exit event; when false the
 * caller owns synthesizing a pty:exit (same contract as the old
 * shutdownProviderAndDetectExit helper in ipc/pty.ts).
 */
export async function shutdownPtyWithDrain(
  provider: IPtyProvider,
  id: string,
  opts: { keepHistory?: boolean; drainWindowMs?: number } = {}
): Promise<boolean> {
  const drainWindowMs = opts.drainWindowMs ?? PTY_EXIT_DRAIN_WINDOW_MS
  let exited = false
  let signalExit: (() => void) | null = null
  const exitSeen = new Promise<void>((resolve) => {
    signalExit = resolve
  })
  const unsubscribe = provider.onExit((payload) => {
    if (payload.id === id) {
      exited = true
      signalExit?.()
    }
  })
  let drainTimer: ReturnType<typeof setTimeout> | null = null
  try {
    let gracefulFailed = false
    try {
      await provider.shutdown(id, { immediate: false, keepHistory: opts.keepHistory })
    } catch (err) {
      // Why: an already-gone session keeps the old contract (callers map it to
      // a synthetic exit). Any other graceful failure must NOT skip the forced
      // escalation — callers rely on the PTY being dead when this resolves.
      if (isPtyAlreadyGoneError(err)) {
        throw err
      }
      gracefulFailed = true
    }
    if (!exited && !gracefulFailed) {
      await Promise.race([
        exitSeen,
        new Promise<void>((resolve) => {
          drainTimer = setTimeout(resolve, drainWindowMs)
          drainTimer.unref?.()
        })
      ])
    }
    if (!exited) {
      try {
        await provider.shutdown(id, { immediate: true, keepHistory: opts.keepHistory })
      } catch (err) {
        // Why: the graceful shutdown can still win the race right as the
        // window expires; a vanished session is success, not a failure.
        if (!exited && !isPtyAlreadyGoneError(err)) {
          throw err
        }
      }
    }
    return exited
  } finally {
    unsubscribe()
    if (drainTimer) {
      clearTimeout(drainTimer)
    }
  }
}
