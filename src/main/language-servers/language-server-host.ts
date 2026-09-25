// Language-server host (spec §4 + §6): session management keyed by worktree
// root, document routing, and S2 lifecycle — prewarm-on-didOpen, 10min idle
// shutdown, LRU cap-3 + toast, clangd version gate (PATH probe, <12 refuses).
// S3 (ticket 13): the D9 compile-db strategy runs at session start — detect
// an existing db, else CMake-generate one; on failure degrade + .clangd
// fallback. clangd is pointed at the resolved dir explicitly (no symlink).
// Ticket 16: the per-host seam (native spawnProcess vs WSL wsl.exe --exec,
// native file: URI vs WSL UNC<->guest mapping, native PATH vs guest PATH)
// is selected per worktree through `selectHostAdapter` so the session +
// lifecycle machinery are host-agnostic.
import { openClangdSession, type ClangdSession } from './clangd-session'
import { normalizeHostFileKey, selectHostAdapterForHost } from './language-server-host-adapter'
import { startClangdSession } from './language-server-session-start'
import { SessionRespawnReplay, sessionKeyFor } from './lsp-reconnect-replay'
import {
  clearIdleTimer,
  maybeArmIdleTimer,
  touchSession
} from './language-server-session-lifecycle'
import type {
  ClangdVersionGate,
  CompileDbStrategyFactory,
  HostAdapterSelector,
  LanguageServerHost,
  LanguageServerHostEvents,
  SessionEntry
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
  dbStrategyFactory: CompileDbStrategyFactory | null = null,
  /** Test seam: override host-adapter selection (native vs WSL vs SSH) without a real distro/target. */
  selectAdapter: HostAdapterSelector = selectHostAdapterForHost
): LanguageServerHost {
  const sessionsByKey = new Map<string, SessionEntry>()
  const sessionKeyByDocument = new Map<string, string>()
  /** Reconnect replay: retains open docs across a died session for respawn (spec §6). */
  const respawnReplay = new SessionRespawnReplay()
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

  function ensureSession(worktreeRoot: string, sshTargetId: string | null): Promise<ClangdSession> {
    const key = sessionKeyFor(worktreeRoot, sshTargetId, normalizeHostFileKey)
    // Select the host adapter once per session: native / WSL / SSH (relay lsp.*).
    const adapter = selectAdapter(worktreeRoot, sshTargetId)
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
    const startPromise = startClangdSession(
      { key, adapter, events, versionGate, dbStrategyFactory, sessionsByKey, dropSession, log },
      openSession,
      (error) => {
        if (error) {
          log(`[language-servers] session for ${key} died: ${error.message}`)
        }
        respawnReplay.captureOnExit(key, sessionsByKey.get(key)?.openDocumentTexts ?? new Map())
        dropSession(key)
      }
    ).then((session) => {
      log(
        `[language-servers] clangd ${session.serverVersion ?? 'unknown version'} ready for ${key}`
      )
      return session
    })
    const entry: SessionEntry = {
      key,
      session: null,
      startPromise,
      openDocuments: new Set(),
      openDocumentTexts: new Map(),
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
        // Reconnect replay (spec §6): respawn reissues didOpen for retained open docs.
        respawnReplay.replayOnRespawn(
          session,
          key,
          entry,
          sessionKeyByDocument,
          normalizeHostFileKey,
          (n) =>
            n > 0 &&
            log(`[language-servers] replayed ${n} open document(s) after respawn for ${key}`)
        )
      })
      .catch(() => {
        dropSession(key)
      })
    return startPromise
  }

  function sessionForDocument(filePath: string): ClangdSession | null {
    const key = normalizeHostFileKey(filePath)
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
    async openDocument({ worktreeRoot, filePath, text, connectionId }) {
      try {
        const sshTargetId = connectionId ?? null
        const sessionKey = sessionKeyFor(worktreeRoot, sshTargetId, normalizeHostFileKey)
        const session = await ensureSession(worktreeRoot, sshTargetId)
        const key = normalizeHostFileKey(filePath)
        const entry = sessionsByKey.get(sessionKey)
        if (entry) {
          entry.openDocuments.add(key)
          entry.openDocumentTexts.set(key, text) // retained for respawn replay
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
        const normalized = session.didChange(normalizeHostFileKey(filePath), version, changes)
        touchSessionLocal(sessionKeyByDocument.get(normalizeHostFileKey(filePath)) ?? '')
        return { ok: true as const, version: normalized }
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    },
    closeDocument({ filePath }) {
      const key = normalizeHostFileKey(filePath)
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
          entry.openDocumentTexts.delete(key)
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
      return session.definition(normalizeHostFileKey(filePath), position)
    },
    async references({ filePath, position }) {
      const session = sessionForDocument(filePath)
      if (!session) {
        throw new Error(`no language-server session owns ${filePath}`)
      }
      return session.references(normalizeHostFileKey(filePath), position)
    },
    async declaration({ filePath, position }) {
      const session = sessionForDocument(filePath)
      if (!session) {
        throw new Error(`no language-server session owns ${filePath}`)
      }
      return session.declaration(normalizeHostFileKey(filePath), position)
    },
    async hover({ filePath, position }) {
      const session = sessionForDocument(filePath)
      if (!session) {
        throw new Error(`no language-server session owns ${filePath}`)
      }
      return session.hover(normalizeHostFileKey(filePath), position)
    },
    async semanticTokens({ filePath }) {
      const session = sessionForDocument(filePath)
      if (!session) {
        throw new Error(`no language-server session owns ${filePath}`)
      }
      return session.semanticTokensFull(normalizeHostFileKey(filePath))
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
