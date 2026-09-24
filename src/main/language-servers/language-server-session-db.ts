// Session-start compile-db resolution (spec D9 + §6): wraps the db-strategy
// factory selection and hooks the strategy's degraded/toast/status events into
// the host event surface. Split out of language-server-host.ts so the host
// stays under its line budget; the strategy itself lives in compile-db/.
import { createCompileDbStrategy } from './compile-db/compile-db-strategy-orchestrator'
import { runProcess } from '../../shared/child-process/run-process'
import type {
  CompileDbStrategy,
  CompileDbStrategyFactory,
  CompileDbStrategyHooks,
  LanguageServerHostEvents
} from './language-server-host-types'
import type { CompileDbResolution } from './compile-db/compile-db-strategy-types'

/** Build the db-strategy hooks that forward to the host event surface. */
export function buildDbStrategyHooks(
  events: LanguageServerHostEvents,
  log: (line: string) => void
): CompileDbStrategyHooks {
  return {
    onStatus: (text) => events.onStatus?.(text),
    onDegraded: (message) => events.onDegraded?.(message),
    onToast: (message) => events.onToast?.(message),
    onLog: log
  }
}

/**
 * Resolves the compile db for a session: uses the injected factory when present
 * (tests), otherwise the real CMake/degraded strategy. Returns both the
 * resolution and the strategy (so the host can dispose it on session drop).
 */
export async function resolveSessionCompileDb(
  worktreeRoot: string,
  events: LanguageServerHostEvents,
  log: (line: string) => void,
  dbStrategyFactory: CompileDbStrategyFactory | null
): Promise<{ resolution: CompileDbResolution; strategy: CompileDbStrategy }> {
  const hooks = buildDbStrategyHooks(events, log)
  const strategy = dbStrategyFactory
    ? dbStrategyFactory(worktreeRoot, hooks)
    : createCompileDbStrategy(worktreeRoot, hooks, runProcess)
  const resolution = await strategy.resolve()
  return { resolution, strategy }
}
