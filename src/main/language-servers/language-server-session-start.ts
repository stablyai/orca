// Session-start sequence for the language-server host (spec §6 + D7/D9): the
// version gate, LRU cap, compile-db strategy, and clangd spawn — extracted from
// language-server-host.ts so that file stays under its line budget. The host
// calls `startClangdSession` per `ensureSession`; the respawn-replay wiring
// stays in the host (it owns the session entry + document tables).
import type { ClangdSession, openClangdSession } from './clangd-session'
import { buildDbStrategyHooks } from './language-server-session-db'
import { evictLeastRecentlyUsed } from './language-server-session-lifecycle'
import {
  LANGUAGE_SERVER_MAX_CONCURRENT_SESSIONS,
  type ClangdVersionGate,
  type CompileDbStrategyFactory,
  type LanguageServerHostEvents,
  type SessionEntry
} from './language-server-host-types'
import type { LanguageServerHostAdapter } from './language-server-host-adapter'

export type StartSessionDeps = {
  key: string
  adapter: LanguageServerHostAdapter
  events: LanguageServerHostEvents
  versionGate: ClangdVersionGate | null
  dbStrategyFactory: CompileDbStrategyFactory | null
  sessionsByKey: Map<string, SessionEntry>
  /** Drop the session entry (idle/LRU/reject paths). */
  dropSession: (key: string) => void
  log: (line: string) => void
}

/**
 * Run the version gate → LRU cap → compile-db strategy → spawn sequence for one
 * session key. Returns the live ClangdSession. The `onExit` callback wires the
 * host's respawn-replay capture + dropSession (passed by the caller so the
 * host owns the entry lifecycle).
 */
export async function startClangdSession(
  deps: StartSessionDeps,
  openSession: typeof openClangdSession,
  onExit: (error: Error | null) => void
): Promise<ClangdSession> {
  const { key, adapter, events, versionGate, dbStrategyFactory, sessionsByKey, dropSession, log } =
    deps
  const program = adapter.resolveClangdProgram()
  const gateProbe = versionGate ?? ((p: string) => adapter.resolveClangdVersionGate(p))
  const gate = await gateProbe(program)
  const gateEntry = sessionsByKey.get(key)
  if (gateEntry) {
    gateEntry.gate = gate
  }
  if (gate.kind === 'reject') {
    if (gate.message) {
      events.onDegraded?.(gate.message)
    }
    dropSession(key)
    throw new Error(gate.message ?? 'clangd unavailable')
  }
  if (gate.kind === 'suggest-upgrade' && gate.message) {
    events.onDegraded?.(gate.message)
  } else if (gate.kind === 'ok') {
    events.onDegraded?.(null)
  }
  // LRU cap: evict before the 4th session materializes (spec §6).
  const liveCount = [...sessionsByKey.values()].filter(
    (entry) => entry.session && !entry.session.died
  ).length
  if (liveCount >= LANGUAGE_SERVER_MAX_CONCURRENT_SESSIONS) {
    await evictLeastRecentlyUsed(sessionsByKey, events, log, dropSession)
  }
  // D9 compile-db strategy (spec §6): detect or CMake-generate the db before
  // spawn; on failure clangd still starts in single-file mode.
  const dbStrategy = dbStrategyFactory
    ? dbStrategyFactory(key, buildDbStrategyHooks(events, log))
    : adapter.createDbStrategy(key, buildDbStrategyHooks(events, log))
  const dbResolution = await dbStrategy.resolve()
  const strategyEntry = sessionsByKey.get(key)
  if (strategyEntry) {
    strategyEntry.dbStrategy = dbStrategy
  } else {
    dbStrategy.dispose()
  }
  const launch = await adapter.buildLaunch(key, {
    compileCommandsDir: dbResolution.compileCommandsDir
  })
  log(`[language-servers] starting clangd for ${key}: ${launch.program} ${launch.args.join(' ')}`)
  return openSession({
    program: launch.program,
    args: launch.args,
    cwd: launch.cwd,
    env: launch.env,
    rootPath: key,
    adapter,
    onStatus: (text) => events.onStatus?.(text),
    onLog: log,
    onExit
  })
}
