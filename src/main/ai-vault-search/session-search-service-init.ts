import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AiVaultSessionSearchInit } from '../ai-vault/session-scanner-service-protocol'
import { sessionSearchDatabasePath } from './session-search-database-path'
import { sessionSearchPolicy } from './session-search-policy'

// Keep early imports inert until the composition root installs the data path.
let databasePath: string | null = null

export function installSessionSearchDataRoot(dataRoot: string): void {
  databasePath = sessionSearchDatabasePath(dataRoot)
}

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
