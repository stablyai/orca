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

/**
 * Resolves when the pass finishes or the wait runs out; at once with the gate closed. `before`
 * (the reset of an interrupted move) runs first, inside the same wait, and its failure never
 * skips the pass.
 */
export function runWslMoveStartupRewrite(
  options: WslMoveDesktopRewritePassOptions,
  before: () => Promise<unknown> = () => Promise.resolve(),
  waitMs: number = WSL_MOVE_STARTUP_REWRITE_WAIT_MS
): Promise<void> {
  if (!wslHostsGateOpen()) {
    return Promise.resolve()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs)
    timer.unref?.()
  })
  const pass = Promise.resolve()
    .then(before)
    .catch((error: unknown) => {
      console.warn('[wsl-move] Startup recovery failed before the desktop rewrite:', error)
    })
    .then(() => runWslMoveDesktopRewritePass(options))
  return Promise.race([pass, waited]).finally(() => clearTimeout(timer))
}
