import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrcaFocusDeepLink } from './orca-deep-link'

// Why a structural slice: the dispatcher only reads graph readiness and reuses the two
// existing focus actions, so unit tests stay free of the full OrcaRuntimeService while
// remaining type-checked against the real class.
export type FocusableRuntime = Pick<
  OrcaRuntimeService,
  'getStatus' | 'focusTerminal' | 'resolveActiveTerminal'
>

export type DeepLinkDispatcherOptions = {
  /** Read lazily: a cold-start link is dispatched before the runtime is constructed. */
  getRuntime: () => FocusableRuntime | null
  warn?: (message: string, error?: unknown) => void
  now?: () => number
  delay?: (ms: number) => Promise<void>
  graphReadyTimeoutMs?: number
  graphPollIntervalMs?: number
}

export type DeepLinkDispatcher = {
  dispatch: (link: OrcaFocusDeepLink) => Promise<void>
}

// Why 60s: a protocol launch can cold-start Orca, and the renderer graph only reports
// `ready` once the window has loaded — tens of seconds on a cold machine. The intent is
// held for the whole budget rather than dropped by a timeout that races the load screen.
// Nothing blocks on this wait: the activation gate surfaces the window independently and
// only the pane reveal defers. Past the budget the app is simply left in the foreground.
const DEFAULT_GRAPH_READY_TIMEOUT_MS = 60_000
const DEFAULT_GRAPH_POLL_INTERVAL_MS = 150

/**
 * Turn a parsed `orca://focus` link into a pane reveal. Waits for the runtime graph to be
 * ready, then reuses `resolveActiveTerminal`/`focusTerminal` — the same actions behind
 * `orca terminal focus` — so a link can never do more than the CLI already can. Every
 * side effect is injected so the dispatcher is testable without Electron or a runtime.
 */
export function createDeepLinkDispatcher(options: DeepLinkDispatcherOptions): DeepLinkDispatcher {
  const now = options.now ?? Date.now
  const delay = options.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const timeoutMs = options.graphReadyTimeoutMs ?? DEFAULT_GRAPH_READY_TIMEOUT_MS
  const pollIntervalMs = options.graphPollIntervalMs ?? DEFAULT_GRAPH_POLL_INTERVAL_MS

  // Why polled: the runtime flips `graphStatus` inside its window-graph sync and exposes
  // no ready event, so the status snapshot is the only honest signal available here.
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

  async function dispatch(link: OrcaFocusDeepLink): Promise<void> {
    if (!link.terminal && !link.worktree) {
      // A bare `orca://focus` is satisfied by the desktop activation that already ran.
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
      // Why swallowed: an exited handle or a worktree with no terminal is a stale link,
      // not a fault; the app is already in the foreground, so degrade to a no-op.
      options.warn?.('[deep-link] Could not focus terminal for deep link', error)
    }
  }

  return { dispatch }
}
