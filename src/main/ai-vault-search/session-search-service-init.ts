import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AiVaultSessionSearchInit } from '../ai-vault/session-scanner-service-protocol'
import { sessionSearchDatabasePath } from './session-search-database-path'
import { sessionSearchPolicy } from './session-search-policy'

// Captured once from the composition root's data path, like the parse cache:
// every export is inert until then, so no test or early import can index.
let databasePath: string | null = null

export function installSessionSearchDataRoot(dataRoot: string): void {
  databasePath = sessionSearchDatabasePath(dataRoot)
}

/** Read at every spawn and every settings change; null before the data root is installed. */
export function sessionSearchServiceInit(): AiVaultSessionSearchInit | null {
  return databasePath
    ? {
        databasePath,
        settings: sessionSearchPolicy(),
        roots: { executionHostId: LOCAL_EXECUTION_HOST_ID }
      }
    : null
}

export function resetSessionSearchServiceInitForTests(): void {
  databasePath = null
}
