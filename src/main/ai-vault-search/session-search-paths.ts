import { join } from 'node:path'
import type { AiVaultSessionSearchInit } from '../ai-vault/session-scanner-service-protocol'

// Why: like the parse cache, the index path is captured once at the composition
// root from the canonical userData dir; every export is a no-op until then.
let init: AiVaultSessionSearchInit | null = null

export function initSessionSearchPaths(userDataPath: string): void {
  init = { databasePath: join(userDataPath, 'ai-vault-search', 'index.sqlite') }
}

export function getSessionSearchInitOptions(): AiVaultSessionSearchInit | null {
  return init ? { ...init } : null
}

export function resetSessionSearchPathsForTests(): void {
  init = null
}
