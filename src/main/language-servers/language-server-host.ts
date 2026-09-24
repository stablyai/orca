// Language-server host (spec §4): session management keyed by worktree root
// and document routing. S1 (ticket 11) keeps this deliberately single-purpose —
// no idle eviction, no concurrency caps, no LRU (those are ticket 12).
import { buildClangdLaunch } from './clangd-launch'
import { openClangdSession, type ClangdSession } from './clangd-session'
import { normalizeNativeFilePath } from './uri-mapping'
import type {
  LanguageServerDefinitionLocation,
  LanguageServerDocumentChange,
  LanguageServerHoverContent,
  LanguageServerPosition
} from '../../shared/language-server-navigation-types'

export type LanguageServerHostEvents = {
  /** `$/progress` projection; null clears the status line. */
  onStatus?: (text: string | null) => void
  onLog?: (line: string) => void
}

export type LanguageServerHost = {
  openDocument(args: {
    worktreeRoot: string
    filePath: string
    text: string
  }): Promise<{ ok: true } | { ok: false; error: string }>
  changeDocument(args: {
    filePath: string
    version: number
    changes: readonly LanguageServerDocumentChange[]
  }): { ok: true; version: number } | { ok: false; error: string }
  closeDocument(args: { filePath: string }): { ok: true } | { ok: false; error: string }
  definition(args: {
    filePath: string
    position: LanguageServerPosition
  }): Promise<LanguageServerDefinitionLocation[]>
  hover(args: {
    filePath: string
    position: LanguageServerPosition
  }): Promise<LanguageServerHoverContent | null>
  /** shutdown -> exit for every live session (app quit path). */
  shutdownAll(): Promise<void>
  /** Test seam: live session count. */
  readonly sessionCount: number
}

type SessionEntry = {
  key: string
  session: ClangdSession | null
  startPromise: Promise<ClangdSession> | null
}

export function createLanguageServerHost(
  events: LanguageServerHostEvents = {},
  openSession: typeof openClangdSession = openClangdSession
): LanguageServerHost {
  const sessionsByKey = new Map<string, SessionEntry>()
  const sessionKeyByDocument = new Map<string, string>()

  const log = (line: string): void => events.onLog?.(line)

  function dropSession(key: string): void {
    const entry = sessionsByKey.get(key)
    if (!entry) {
      return
    }
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
      } else if (existing.startPromise) {
        return existing.startPromise
      } else if (existing.session) {
        return Promise.resolve(existing.session)
      }
    }
    const launch = buildClangdLaunch(key)
    const startPromise = (async () => {
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
    const entry: SessionEntry = { key, session: null, startPromise }
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

  return {
    get sessionCount(): number {
      return sessionsByKey.size
    },
    async openDocument({ worktreeRoot, filePath, text }) {
      try {
        const session = await ensureSession(worktreeRoot)
        const key = normalizeNativeFilePath(filePath)
        // Re-open after a same-path model recreation (tab close -> reopen) keeps
        // one authoritative entry: the owning session is whatever served it last.
        sessionKeyByDocument.set(key, normalizeNativeFilePath(worktreeRoot))
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
        return { ok: true as const, version: normalized }
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    },
    closeDocument({ filePath }) {
      const key = normalizeNativeFilePath(filePath)
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
  hostSingleton = createLanguageServerHost({
    onLog: (line) => console.log(line),
    ...events
  })
  return hostSingleton
}

/** Test seam: reset the process-wide singleton. */
export function resetLanguageServerHostForTests(): void {
  hostSingleton = null
}
