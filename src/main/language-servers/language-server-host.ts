// Language-server host (spec §4 + §6): session management keyed by worktree
// root, document routing, and S2 lifecycle — prewarm-on-didOpen, 10min idle
// shutdown, LRU cap-3 + toast, clangd version gate (PATH probe, <12 refuses).
// S3 (ticket 13): the D9 compile-db strategy runs at session start — detect
// an existing db, else CMake-generate one; on failure degrade + .clangd
// fallback. clangd is pointed at the resolved dir explicitly (no symlink).
import { buildClangdLaunch, resolveClangdProgram } from './clangd-launch'
import { openClangdSession, type ClangdSession } from './clangd-session'
import { normalizeNativeFilePath } from './uri-mapping'
import { resolveSessionCompileDb } from './language-server-session-db'
import {
  clearIdleTimer,
  evictLeastRecentlyUsed,
  maybeArmIdleTimer,
  touchSession
} from './language-server-session-lifecycle'
import {
  LANGUAGE_SERVER_MAX_CONCURRENT_SESSIONS,
  type ClangdVersionGate,
  type CompileDbStrategyFactory,
  type LanguageServerHost,
  type LanguageServerHostEvents,
  type SessionEntry
} from './language-server-host-types'

export {
  LANGUAGE_SERVER_IDLE_TIMEOUT_MS,
  LANGUAGE_SERVER_MAX_CONCURRENT_SESSIONS,
  type ClangdVersionGate,
  type LanguageServerHost,
  type LanguageServerHostEvents
} from './language-server-host-types'

export function createLanguageServerHost(
  events: LanguageServerHostEvents = {},
  openSession: typeof openClangdSession = openClangdSession,
  versionGate: ClangdVersionGate | null = null,
  dbStrategyFactory: CompileDbStrategyFactory | null = null
): LanguageServerHost {
  const sessionsByKey = new Map<string, SessionEntry>()
  const sessionKeyByDocument = new Map<string, string>()
  const log = (line: string): void => events.onLog?.(line)

  function dropSession(key: string): void {
    const entry = sessionsByKey.get(key)
    if (!entry) {
      return
    }
    clearIdleTimer(entry)
    entry.dbStrategy?.dispose()
    entry.dbStrategy = null
    sessionsByKey.delete(key)
    for (const [docPath, ownerKey] of sessionKeyByDocument) {
      if (ownerKey === key) {
        sessionKeyByDocument.delete(docPath)
      }
    }
  }

  function ensureSession(worktreeRoot: string): Promise<ClangdSession> {
    const key = normalizeNativeFilePath(worktreeRoot)
    const existing = sessionsByKey.get(key)
    if (existing) {
      if (existing.session?.died) {
        dropSession(key)
      } else if (existing.gate?.kind === 'reject') {
        // A prior probe already refused this binary; surface the hint again.
        if (existing.gate.message) {
          events.onDegraded?.(existing.gate.message)
        }
        return Promise.reject(new Error(existing.gate.message ?? 'clangd unavailable'))
      } else if (existing.startPromise) {
        return existing.startPromise
      } else if (existing.session) {
        return Promise.resolve(existing.session)
      }
    }
    const program = resolveClangdProgram()
    const startPromise = (async () => {
      // Version gate (spec D7): probe before spawning. <12/absent -> reject,
      // 12-15 -> suggest-upgrade, >=16 -> ok.
      if (versionGate) {
        const gate = await versionGate(program)
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
      }
      // LRU cap: evict before the 4th session materializes (spec §6).
      const liveCount = [...sessionsByKey.values()].filter(
        (entry) => entry.session && !entry.session.died
      ).length
      if (liveCount >= LANGUAGE_SERVER_MAX_CONCURRENT_SESSIONS) {
        await evictLeastRecentlyUsed(sessionsByKey, events, log, dropSession)
      }
      // D9 compile-db strategy (spec §6): detect or CMake-generate the db
      // before spawn; on failure clangd still starts in single-file mode.
      const { resolution: dbResolution, strategy } = await resolveSessionCompileDb(
        key,
        events,
        log,
        dbStrategyFactory
      )
      const strategyEntry = sessionsByKey.get(key)
      if (strategyEntry) {
        strategyEntry.dbStrategy = strategy
      } else {
        strategy.dispose()
      }
      const launch = buildClangdLaunch(key, { compileCommandsDir: dbResolution.compileCommandsDir })
      log(
        `[language-servers] starting clangd for ${key}: ${launch.program} ${launch.args.join(' ')}`
      )
      const session = await openSession({
        program: launch.program,
        args: launch.args,
        rootPath: key,
        onStatus: (text) => events.onStatus?.(text),
        onLog: log,
        onExit: (error) => {
          if (error) {
            log(`[language-servers] session for ${key} died: ${error.message}`)
          }
          dropSession(key)
        }
      })
      log(
        `[language-servers] clangd ${session.serverVersion ?? 'unknown version'} ready for ${key}`
      )
      return session
    })()
    const entry: SessionEntry = {
      key,
      session: null,
      startPromise,
      openDocuments: new Set(),
      lastActivityMs: Date.now(),
      idleTimer: null,
      gate: null,
      dbStrategy: null
    }
    sessionsByKey.set(key, entry)
    startPromise
      .then((session) => {
        entry.session = session
        entry.startPromise = null
      })
      .catch(() => {
        dropSession(key)
      })
    return startPromise
  }

  function sessionForDocument(filePath: string): ClangdSession | null {
    const key = normalizeNativeFilePath(filePath)
    const ownerKey = sessionKeyByDocument.get(key)
    if (!ownerKey) {
      return null
    }
    const entry = sessionsByKey.get(ownerKey)
    if (!entry?.session || entry.session.died) {
      sessionKeyByDocument.delete(key)
      return null
    }
    return entry.session
  }

  function touchSessionLocal(key: string): void {
    const entry = sessionsByKey.get(key)
    if (entry) {
      touchSession(entry)
    }
  }

  /** Arm the idle timer when a worktree's open C/C++ doc count drops to 0. */
  function maybeArmIdleTimerLocal(key: string): void {
    const entry = sessionsByKey.get(key)
    if (!entry?.session || entry.session.died || entry.openDocuments.size > 0) {
      return
    }
    maybeArmIdleTimer(key, entry, log, dropSession)
  }

  return {
    get sessionCount(): number {
      return sessionsByKey.size
    },
    async openDocument({ worktreeRoot, filePath, text }) {
      try {
        const sessionKey = normalizeNativeFilePath(worktreeRoot)
        const session = await ensureSession(worktreeRoot)
        const key = normalizeNativeFilePath(filePath)
        const entry = sessionsByKey.get(sessionKey)
        if (entry) {
          entry.openDocuments.add(key)
          clearIdleTimer(entry)
          entry.lastActivityMs = Date.now()
        }
        // Re-open after a same-path model recreation keeps one authoritative
        // entry: the owning session is whatever served it last.
        sessionKeyByDocument.set(key, sessionKey)
        session.didOpen(key, text)
        return { ok: true as const }
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    },
    changeDocument({ filePath, version, changes }) {
      const session = sessionForDocument(filePath)
      if (!session) {
        return { ok: false as const, error: `no language-server session owns ${filePath}` }
      }
      try {
        const normalized = session.didChange(normalizeNativeFilePath(filePath), version, changes)
        touchSessionLocal(sessionKeyByDocument.get(normalizeNativeFilePath(filePath)) ?? '')
        return { ok: true as const, version: normalized }
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    },
    closeDocument({ filePath }) {
      const key = normalizeNativeFilePath(filePath)
      const ownerKey = sessionKeyByDocument.get(key)
      const session = sessionForDocument(filePath)
      if (!session) {
        return { ok: true as const }
      }
      try {
        session.didClose(key)
      } catch (error) {
        log(
          `[language-servers] didClose for ${key} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
      sessionKeyByDocument.delete(key)
      if (ownerKey) {
        const entry = sessionsByKey.get(ownerKey)
        if (entry) {
          entry.openDocuments.delete(key)
          maybeArmIdleTimerLocal(ownerKey)
        }
      }
      return { ok: true as const }
    },
    async definition({ filePath, position }) {
      const session = sessionForDocument(filePath)
      if (!session) {
        throw new Error(`no language-server session owns ${filePath}`)
      }
      return session.definition(normalizeNativeFilePath(filePath), position)
    },
    async references({ filePath, position }) {
      const session = sessionForDocument(filePath)
      if (!session) {
        throw new Error(`no language-server session owns ${filePath}`)
      }
      return session.references(normalizeNativeFilePath(filePath), position)
    },
    async declaration({ filePath, position }) {
      const session = sessionForDocument(filePath)
      if (!session) {
        throw new Error(`no language-server session owns ${filePath}`)
      }
      return session.declaration(normalizeNativeFilePath(filePath), position)
    },
    async hover({ filePath, position }) {
      const session = sessionForDocument(filePath)
      if (!session) {
        throw new Error(`no language-server session owns ${filePath}`)
      }
      return session.hover(normalizeNativeFilePath(filePath), position)
    },
    async semanticTokens({ filePath }) {
      const session = sessionForDocument(filePath)
      if (!session) {
        throw new Error(`no language-server session owns ${filePath}`)
      }
      return session.semanticTokensFull(normalizeNativeFilePath(filePath))
    },
    async shutdownAll() {
      const entries = [...sessionsByKey.values()]
      sessionsByKey.clear()
      sessionKeyByDocument.clear()
      await Promise.all(
        entries.map(async (entry) => {
          clearIdleTimer(entry)
          entry.dbStrategy?.dispose()
          entry.dbStrategy = null
          const session = entry.startPromise
            ? await entry.startPromise.catch(() => null)
            : entry.session
          await session?.stop()
        })
      )
    }
  }
}

// Re-export the process-wide singleton + test reset so existing importers
// (the IPC facade) keep resolving from this module's path. The singleton
// itself lives in language-server-host-singleton.ts (keeps this file lean).
export {
  getLanguageServerHost,
  resetLanguageServerHostForTests
} from './language-server-host-singleton'
