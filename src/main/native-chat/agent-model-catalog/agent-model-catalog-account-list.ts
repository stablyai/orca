import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { isNativeLocalLocation } from '../../../shared/execution-host'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import {
  agentModelCatalogListingKey,
  agentModelCatalogResultFromEntry
} from './agent-model-catalog-entry'
import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import { agentModelCatalogScopedRecord } from './agent-model-catalog-read-scope'
import type {
  AgentModelCatalogReadParams,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'

export function seedAccountList(
  deps: AgentModelCatalogServiceDeps,
  scope: { exact: boolean; fingerprint: string; base: string; accountListing?: boolean },
  agent: string
): void {
  if (!scope.exact || !scope.accountListing || scope.fingerprint === scope.base) {
    return
  }
  const entry = deps.store.observation(scope.fingerprint)
  if (!entry || entry.discovered?.complete !== true) {
    return
  }
  const listing = entry.discovered
  // Configured effort may already be folded into rows; only the folder can declare its default.
  const models = listing.models.map(
    ({ defaultEffort: _effort, declaredDefaultEffort: _declared, ...model }) => ({
      ...model,
      isDefault: false
    })
  )
  const discovered = { ...listing, models }
  const previous = deps.store.observation(scope.base)
  if (
    !previous ||
    agentModelCatalogListingKey(previous) !==
      agentModelCatalogListingKey({ ...entry, discovered, live: null, configured: null })
  ) {
    deps.store.recordSuccess(scope.base, agent, discovered, 'discovery')
  }
}

export function readAccountList(
  deps: AgentModelCatalogServiceDeps,
  params: AgentModelCatalogReadParams,
  result: AgentSessionModelCatalogResult,
  accountBase: () => string | undefined
): AgentSessionModelCatalogResult {
  if (
    result.origin !== 'unknown' ||
    params.records === null ||
    params.operation?.current() === false ||
    params.savedOnly ||
    params.verifiedOnly ||
    params.legacy ||
    !independentAgentModelCatalog(params.agent)
  ) {
    return result
  }
  const record = agentModelCatalogScopedRecord(deps, params)
  const base = record
    ? record.provider === params.agent &&
      deps.drivesRecord(record) &&
      isNativeLocalLocation(record.location)
      ? agentModelCatalogFingerprintForRecord(record)
      : null
    : accountBase()
  const entry = base ? deps.store.observation(base) : null
  return entry
    ? {
        ...agentModelCatalogResultFromEntry(entry, false, false, false),
        modelsDifferByWorkspace: true,
        ...(result.listingInProgress ? { listingInProgress: true as const } : {})
      }
    : result
}
