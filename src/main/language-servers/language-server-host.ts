// Language-server host (spec §4 + §6): session management keyed by worktree
// root, document routing, and S2 lifecycle — prewarm-on-didOpen, 10min idle
// shutdown, LRU cap-3 + toast, clangd version gate (PATH probe, <12 refuses).
import { buildClangdLaunch, resolveClangdVersionGate } from './clangd-launch'
import { openClangdSession, type ClangdSession } from './clangd-session'
import { normalizeNativeFilePath } from './uri-mapping'
import {
  LANGUAGE_SERVER_IDLE_TIMEOUT_MS,
  LANGUAGE_SERVER_MAX_CONCURRENT_SESSIONS,
  type ClangdVersionGate,
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
  versionGate: ClangdVersionGate | null = null
): LanguageServerHost {
  const sessionsByKey = new Map<string, SessionEntry>()
  const sessionKeyByDocument = new Map<string, string>()
  const log = (line: string): void => events.onLog?.(line)

  function clearIdleTimer(entry: SessionEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
  }
  function dropSession(key: string): void {
    const entry = sessionsByKey.get(key)
    if (!entry) {
      return
    }
    clearIdleTimer(entry)
    sessionsByKey.delete(key)
    for (const [docPath, ownerKey] of sessionKeyByDocument) {
      if (ownerKey === key) {
        sessionKeyByDocument.delete(docPath)
      }
    }
  }

  /** LRU eviction: stop the least-recently-active live session + toast. */
  async function evictLeastRecentlyUsed(): Promise<void> {
    let victim: SessionEntry | null = null
    for (const entry of sessionsByKey.values()) {
      if (entry.startPromise || entry.session?.died) {
        continue
      }
      if (!victim || entry.lastActivityMs < victim.lastActivityMs) {
        victim = entry
      }
    }
    if (!victim) {
      return
    }
    const victimKey = victim.key
    log(`[language-servers] evicting ${victimKey} (lru-cap)`)
    dropSession(victimKey)
    await victim.session?.stop().catch(() => {})
    events.onToast?.(
      `Language server for ${victimKey.split(/[\\/]/).pop() ?? victimKey} was stopped to stay under the 3-session limit.`
    )
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
    const launch = buildClangdLaunch(key)
    const startPromise = (async () => {
      // Version gate (spec D7): probe before spawning. <12/absent -> reject,
      // 12-15 -> suggest-upgrade, >=16 -> ok.
      if (versionGate) {
        const gate = await versionGate(launch.program)
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
        await evictLeastRecentlyUsed()
      }
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
      gate: null
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

  function touchSession(key: string): void {
    const entry = sessionsByKey.get(key)
    if (entry) {
      entry.lastActivityMs = Date.now()
      clearIdleTimer(entry)
    }
  }

  /** Arm the idle timer when a worktree's open C/C++ doc count drops to 0. */
  function maybeArmIdleTimer(key: string): void {
    const entry = sessionsByKey.get(key)
    if (!entry?.session || entry.session.died || entry.openDocuments.size > 0) {
      return
    }
    clearIdleTimer(entry)
    entry.idleTimer = setTimeout(() => {
      void (async () => {
        if (entry.openDocuments.size > 0) {
          return
        }
        log(`[language-servers] idle timeout — shutting down ${key}`)
        dropSession(key)
        await entry.session?.stop().catch(() => {})
      })()
    }, LANGUAGE_SERVER_IDLE_TIMEOUT_MS)
    entry.idleTimer.unref?.()
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
        touchSession(sessionKeyByDocument.get(normalizeNativeFilePath(filePath)) ?? '')
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
          maybeArmIdleTimer(ownerKey)
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
    async hover({ filePath, position }) {
      const session = sessionForDocument(filePath)
      if (!session) {
        throw new Error(`no language-server session owns ${filePath}`)
      }
      return session.hover(normalizeNativeFilePath(filePath), position)
    },
    async shutdownAll() {
      const entries = [...sessionsByKey.values()]
      sessionsByKey.clear()
      sessionKeyByDocument.clear()
      await Promise.all(
        entries.map(async (entry) => {
          clearIdleTimer(entry)
          const session = entry.startPromise
            ? await entry.startPromise.catch(() => null)
            : entry.session
          await session?.stop()
        })
      )
    }
  }
}

let hostSingleton: LanguageServerHost | null = null

/** Process-wide host. Events bind at first creation; later events are ignored. */
export function getLanguageServerHost(events: LanguageServerHostEvents = {}): LanguageServerHost {
  if (hostSingleton) {
    return hostSingleton
  }
  hostSingleton = createLanguageServerHost(
    { onLog: (line) => console.log(line), ...events },
    openClangdSession,
    resolveClangdVersionGate
  )
  return hostSingleton
}

/** Test seam: reset the process-wide singleton. */
export function resetLanguageServerHostForTests(): void {
  hostSingleton = null
}
