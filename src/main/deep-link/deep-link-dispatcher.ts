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
  // Cold-start links can land before the renderer graph is ready; poll until it
  // is so focus lands on the right pane instead of being dropped.
  graphReadyTimeoutMs?: number
  graphPollIntervalMs?: number
}

export type DeepLinkDispatcher = {
  dispatch: (url: string) => Promise<void>
}

const DEFAULT_GRAPH_READY_TIMEOUT_MS = 15_000
const DEFAULT_GRAPH_POLL_INTERVAL_MS = 150

export function createDeepLinkDispatcher(options: DeepLinkDispatcherOptions): DeepLinkDispatcher {
  const now = options.now ?? Date.now
  const delay = options.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const timeoutMs = options.graphReadyTimeoutMs ?? DEFAULT_GRAPH_READY_TIMEOUT_MS
  const pollIntervalMs = options.graphPollIntervalMs ?? DEFAULT_GRAPH_POLL_INTERVAL_MS

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
