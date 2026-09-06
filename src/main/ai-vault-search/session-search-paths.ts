import { join } from 'node:path'
import type { AiVaultSessionSearchInit } from '../ai-vault/session-scanner-service-protocol'
import { getSessionSearchPolicy } from './session-search-policy'

// Why: like the parse cache, the index path is captured once at the composition
// root from the canonical userData dir; every export is a no-op until then.
let databasePath: string | null = null

export function initSessionSearchPaths(userDataPath: string): void {
  databasePath = join(userDataPath, 'ai-vault-search', 'index.sqlite')
}

export function getSessionSearchDatabasePath(): string | null {
  return databasePath
}

/** Read fresh on every spawn so a consent change reaches a restarted child. */
export function getSessionSearchInitOptions(): AiVaultSessionSearchInit | null {
  return databasePath ? { databasePath, ...getSessionSearchPolicy() } : null
}

export function resetSessionSearchPathsForTests(): void {
  databasePath = null
}
