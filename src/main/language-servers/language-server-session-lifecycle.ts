// Session lifecycle helpers for the language-server host (spec §6): idle
// shutdown, LRU cap eviction, and the idle-timer plumbing. Split out of
// language-server-host.ts so the host module stays under its line budget.
// These operate on the host's SessionEntry map and call back into the host's
// dropSession so the maps stay consistent.
import {
  LANGUAGE_SERVER_IDLE_TIMEOUT_MS,
  LANGUAGE_SERVER_MAX_CONCURRENT_SESSIONS,
  type LanguageServerHostEvents,
  type SessionEntry
} from './language-server-host-types'

/** Clear an entry's armed idle timer; safe when none is armed. */
export function clearIdleTimer(entry: SessionEntry): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = null
  }
}

/** Bump last-activity and cancel the idle timer (a doc re-opened). */
export function touchSession(entry: SessionEntry): void {
  entry.lastActivityMs = Date.now()
  clearIdleTimer(entry)
}

/** Arm the idle timer when a worktree's open C/C++ doc count drops to 0. */
export function maybeArmIdleTimer(
  key: string,
  entry: SessionEntry,
  log: (line: string) => void,
  dropSession: (key: string) => void
): void {
  if (!entry.session || entry.session.died || entry.openDocuments.size > 0) {
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

/** LRU eviction: stop the least-recently-active live session + toast. */
export async function evictLeastRecentlyUsed(
  sessionsByKey: Map<string, SessionEntry>,
  events: LanguageServerHostEvents,
  log: (line: string) => void,
  dropSession: (key: string) => void
): Promise<void> {
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
    `Language server for ${victimKey.split(/[\\/]/).pop() ?? victimKey} was stopped to stay under the ${LANGUAGE_SERVER_MAX_CONCURRENT_SESSIONS}-session limit.`
  )
}
