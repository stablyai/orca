// Write-admission policy for agent-catalog/reference mutations: which writes
// stay allowed while a payload budget is exceeded, and the fail-closed gate
// that blocks every v1 write while the pinned pre-v1 backup is failing.

import type { AgentCatalogMutationRequest } from '../../shared/agent-catalog-snapshot'
import type { AgentCatalogSchemaTooNew } from '../../shared/data-recovery'

/** Mutations that reduce risk/size and stay allowed while a payload budget is
 *  already exceeded; they must never add arbitrary user text or a reference. */
export function isSecurityReducingMutation(request: AgentCatalogMutationRequest): boolean {
  const mutation = request.mutation
  switch (mutation.kind) {
    case 'delete-custom':
      return true
    case 'set-enabled':
      return mutation.enabled === false
    case 'set-default':
      return mutation.agent === 'auto' || mutation.agent === 'blank'
    case 'repair-corrupt':
      return mutation.action.kind === 'discard'
    case 'resolve-duplicate-id':
      return mutation.rows.every((row) => row.action.kind === 'discard')
    case 'create':
    case 'duplicate':
    case 'update-custom':
    case 'update-built-in':
      return false
  }
}

/** Returned while the pinned pre-v1 backup is failing: the profile must stay
 *  pre-v1, so every catalog/reference write is blocked (not merely deferred). */
export type AgentCatalogMigrationBlockedError = {
  ok: false
  code: 'agent_catalog_migration_blocked'
  migrationError: string
}

export function agentCatalogMigrationBlockedError(store: {
  getAgentCatalogMigrationError(): string | null
}): AgentCatalogMigrationBlockedError | null {
  const migrationError = store.getAgentCatalogMigrationError()
  if (migrationError === null) {
    return null
  }
  return { ok: false, code: 'agent_catalog_migration_blocked', migrationError }
}

/** Returned while the persisted catalog schema is newer than this build: authoring
 *  would clobber fields this build cannot represent, and nothing here is retryable
 *  — only a newer Orca clears it. */
export type AgentCatalogSchemaTooNewError = {
  ok: false
  code: 'agent_catalog_schema_too_new'
  persistedVersion: number
  supportedVersion: number
}

export function agentCatalogSchemaTooNewError(store: {
  getAgentCatalogSchemaTooNew(): AgentCatalogSchemaTooNew | null
}): AgentCatalogSchemaTooNewError | null {
  const schemaTooNew = store.getAgentCatalogSchemaTooNew()
  if (schemaTooNew === null) {
    return null
  }
  return {
    ok: false,
    code: 'agent_catalog_schema_too_new',
    persistedVersion: schemaTooNew.persistedVersion,
    supportedVersion: schemaTooNew.supportedVersion
  }
}
