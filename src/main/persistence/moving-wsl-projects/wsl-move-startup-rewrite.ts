/**
 * The startup run of the desktop rewrite stage. The window's first `session:get` and UI read must
 * see a committed move's rewrite, or the renderer hydrates the old routing and later writes it
 * back over the rewrite. So startup waits for the pass, but never long.
 */
import { wslHostsServing } from '../../wsl/wsl-host-gate'
import {
  runWslMoveDesktopRewritePass,
  type WslMoveDesktopRewritePassOptions
} from './wsl-move-desktop-rewrite'

// A pass is a few profile writes and flushes; past this the window opens and the pass finishes
// behind it, holding the window's saves and reloading it.
export const WSL_MOVE_STARTUP_REWRITE_WAIT_MS = 5_000

export type WslMoveStartupRewriteSteps = {
  /** Resets a move interrupted before commit; its failure never skips what follows. */
  recover?: () => Promise<unknown>
}

/**
 * Resolves when the pass finishes or the wait runs out; at once with the gate closed. `recover`
 * runs first inside the same wait. A pass that finishes behind the window reloads it.
 */
export function runWslMoveStartupRewrite(
  options: WslMoveDesktopRewritePassOptions,
  steps: WslMoveStartupRewriteSteps = {}
): Promise<void> {
  if (!wslHostsServing()) {
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
    .then(() => runWslMoveDesktopRewritePass(options))
  return Promise.race([pass, waited]).finally(() => clearTimeout(timer))
}
