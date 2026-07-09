import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { parseOrcaDeepLink, type OrcaFocusDeepLink } from './orca-deep-link'

// Why: the dispatcher only needs to read runtime readiness and reuse the two
// existing focus actions. A structural slice keeps the unit tests free of the
// full OrcaRuntimeService while staying type-checked against the real class.
export type FocusableRuntime = Pick<
  OrcaRuntimeService,
  'getStatus' | 'focusTerminal' | 'resolveActiveTerminal'
>

export type DeepLinkDispatcherOptions = {
  // Bring the app/main window to the foreground (reuses focusExistingMainWindow).
  focusWindow: () => void
  // Lazily read the runtime so a cold-start link that arrives before the
  // runtime exists still resolves once startup completes.
  getRuntime: () => FocusableRuntime | null
  warn?: (message: string, error?: unknown) => void
  now?: () => number
  delay?: (ms: number) => Promise<void>
  // Cold-start links land before the renderer graph is ready; the focus intent
  // is buffered by polling for up to this budget so it applies once the graph
  // reports `ready` instead of being dropped. Never blocks boot — the window is
  // surfaced first; only the terminal reveal waits.
  graphReadyTimeoutMs?: number
  graphPollIntervalMs?: number
}

export type DeepLinkDispatcher = {
  dispatch: (url: string) => Promise<void>
}

// Why: a protocol launch can COLD-START Orca — macOS relaunches the registered
// handler, and the renderer graph only reports `ready` after the window loads,
// which on a fresh/cold boot can take tens of seconds. The focus intent is
// buffered (polled) for this whole budget so it lands once the graph is ready,
// rather than being dropped by a timeout that races the load screen. The window
// itself is surfaced immediately (see `dispatch`), so this wait never blocks the
// boot — it only defers the terminal reveal. After the budget, we gracefully
// no-op with the app already in the foreground.
const DEFAULT_GRAPH_READY_TIMEOUT_MS = 60_000
const DEFAULT_GRAPH_POLL_INTERVAL_MS = 150

/**
 * Create the deep-link dispatcher that turns an `orca://` URL into a focus
 * action. `dispatch` always brings the main window forward first — so an
 * unknown or malformed route still surfaces Orca — then, for a `focus` route
 * that names a target, waits for the runtime graph to be ready and reuses the
 * existing `resolveActiveTerminal`/`focusTerminal` actions to reveal the pane.
 *
 * All side effects (window focus, runtime lookup, timing) are injected via
 * `options` so the dispatcher can be unit-tested without a live Electron or
 * runtime instance.
 */
export function createDeepLinkDispatcher(options: DeepLinkDispatcherOptions): DeepLinkDispatcher {
  const now = options.now ?? Date.now
  const delay = options.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const timeoutMs = options.graphReadyTimeoutMs ?? DEFAULT_GRAPH_READY_TIMEOUT_MS
  const pollIntervalMs = options.graphPollIntervalMs ?? DEFAULT_GRAPH_POLL_INTERVAL_MS

  /**
   * Poll `getRuntime` until the renderer graph reports `ready`, returning the
   * runtime once it is. Returns `null` if the graph is still not ready by the
   * deadline so a cold-start link degrades to a window-only focus.
   */
  async function waitForRuntimeGraph(): Promise<FocusableRuntime | null> {
    const deadline = now() + timeoutMs
    for (;;) {
      const runtime = options.getRuntime()
      if (runtime && runtime.getStatus().graphStatus === 'ready') {
        return runtime
      }
      if (now() >= deadline) {
        return null
      }
      await delay(pollIntervalMs)
    }
  }

  /**
   * Reveal the pane named by a `focus` link. A bare `orca://focus` (no target)
   * is satisfied by the window focus alone. Otherwise resolve the terminal
   * handle — directly or via the worktree selector — and focus it, degrading to
   * a no-op if the runtime is not ready or the handle cannot be resolved.
   */
  async function focusTarget(link: OrcaFocusDeepLink): Promise<void> {
    if (!link.terminal && !link.worktree) {
      // Bare `orca://focus` — bringing the window forward is the whole action.
      return
    }
    const runtime = await waitForRuntimeGraph()
    if (!runtime) {
      options.warn?.('[deep-link] Runtime graph not ready; brought window forward only')
      return
    }
    try {
      const handle =
        link.terminal ?? (await runtime.resolveActiveTerminal(link.worktree ?? undefined))
      await runtime.focusTerminal(handle)
    } catch (error) {
      // Why: an unknown/exited handle or a worktree with no active terminal must
      // never crash the app. The window is already focused, so degrade to a no-op.
      options.warn?.('[deep-link] Could not focus terminal for deep link', error)
    }
  }

  /**
   * Bring the window forward, then route a parsed `focus` link to its target
   * pane. Non-focus or unparseable URLs fall through to the window focus only.
   */
  async function dispatch(url: string): Promise<void> {
    // Why: focus the window first so an unknown or malformed route still brings
    // Orca forward rather than silently doing nothing.
    options.focusWindow()
    const link = parseOrcaDeepLink(url)
    if (link?.kind === 'focus') {
      await focusTarget(link)
    }
  }

  return { dispatch }
}
