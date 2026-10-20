import { lstatSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { CODEX_CONVERSATION_STORE_DIRS, isCodexHomeOnSharedStore } from './codex-conversation-store'
import { readConfiguredCodexSqliteHome, resolveEffectiveCodexSqliteHome } from './codex-sqlite-home'

export const CODEX_SHARED_STORE_MARKER = '# orca: shared conversation store'

/**
 * The store a managed home's conversation directories link into, or null
 * while any of them is still its own. Derived from the links, never saved.
 */
export function linkedCodexConversationStore(homePath: string): string | null {
  let store: string | null = null
  for (const name of CODEX_CONVERSATION_STORE_DIRS) {
    const entry = join(homePath, name)
    try {
      if (!lstatSync(entry).isSymbolicLink()) {
        return null
      }
      const parent = dirname(realpathSync(entry))
      if (store !== null && store !== parent) {
        return null
      }
      store = parent
    } catch {
      return null
    }
  }
  return store
}

/**
 * Points a linked home at its store's SQLite home, so every account reads and
 * moves one current-segment row per thread. A `sqlite_home` the user set wins;
 * an unlinked home gets Orca's line removed.
 */
export function applyCodexSharedStoreConfig(config: string, homePath: string): string {
  const withoutOrcaLine = stripCodexSharedStoreConfig(config)
  // Why: a distro home's links resolve only inside Linux, so distro homes keep their own store for now.
  const store =
    parseWslUncPath(homePath) || !isCodexHomeOnSharedStore(homePath)
      ? null
      : linkedCodexConversationStore(homePath)
  if (!store || readConfiguredCodexSqliteHome(withoutOrcaLine, homePath) !== null) {
    return withoutOrcaLine
  }
  // Top-level keys must precede every table, so the line goes first.
  const line = `sqlite_home = ${JSON.stringify(resolveEffectiveCodexSqliteHome(store))} ${CODEX_SHARED_STORE_MARKER}`
  return withoutOrcaLine.length > 0 ? `${line}\n${withoutOrcaLine}` : `${line}\n`
}

export function stripCodexSharedStoreConfig(config: string): string {
  return config
    .split('\n')
    .filter((line) => !line.trimEnd().endsWith(CODEX_SHARED_STORE_MARKER))
    .join('\n')
}
