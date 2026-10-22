/**
 * The startup run of the desktop rewrite stage. The window's first `session:get` and UI read must
 * see a committed move's rewrite, or the renderer hydrates the old routing and later writes it
 * back over the rewrite. So startup waits for the pass, but never long.
 */
import { wslHostsGateOpen } from '../../wsl/wsl-host-gate'
import {
  runWslMoveDesktopRewritePass,
  type WslMoveDesktopRewritePassOptions
} from './wsl-move-desktop-rewrite'

// A pass is a few profile writes and flushes; past this the window opens and the pass finishes
// behind it, with the stale-hydration risk this wait otherwise closes.
export const WSL_MOVE_STARTUP_REWRITE_WAIT_MS = 5_000

export type WslMoveStartupRewriteSteps = {
  /** Resets a move interrupted before commit; its failure never skips what follows. */
  recover?: () => Promise<unknown>
  /** Corrects what a stale window wrote over a finished rewrite; must not throw. */
  reapply?: () => void
}

/**
 * Resolves when the pass finishes or the wait runs out; at once with the gate closed. `recover`,
 * then `reapply`, run first inside the same wait, so a finished move is corrected even when the
 * pass is slow.
 */
export function runWslMoveStartupRewrite(
  options: WslMoveDesktopRewritePassOptions,
  steps: WslMoveStartupRewriteSteps = {}
): Promise<void> {
  if (!wslHostsGateOpen()) {
    return Promise.resolve()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, WSL_MOVE_STARTUP_REWRITE_WAIT_MS)
    timer.unref?.()
  })
  const pass = Promise.resolve()
    .then(steps.recover)
    .catch((error: unknown) => {
      console.warn('[wsl-move] Startup recovery failed before the desktop rewrite:', error)
    })
    .then(steps.reapply)
    .catch((error: unknown) => {
      console.warn(
        '[wsl-move] Re-applying a finished move failed before the desktop rewrite:',
        error
      )
    })
    .then(() => runWslMoveDesktopRewritePass(options))
  return Promise.race([pass, waited]).finally(() => clearTimeout(timer))
}
