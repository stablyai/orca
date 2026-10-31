import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { isNativeLocalLocation } from '../../../shared/execution-host'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import {
  agentModelCatalogResultFromEntry,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-entry'
import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import { newChatCatalogKey } from './agent-model-catalog-prewarm'
import type {
  AgentModelCatalogReadParams,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'

// Claude/Codex lists are kept per folder, so a folder not yet listed (every new worktree) had
// nothing to show until its own probe finished. The account's own listing stands in meanwhile.

/** Wraps a listing so the account's own one also saves the list unlisted folders show. */
export function seedAccountList(
  deps: AgentModelCatalogServiceDeps,
  scope: { exact: boolean; fingerprint: string; base: string; accountListing?: boolean },
  agent: string,
  current: () => boolean
): (list: () => Promise<AgentModelCatalogSuccess>) => () => Promise<AgentModelCatalogSuccess> {
  return (list) =>
    !scope.exact || !scope.accountListing || scope.fingerprint === scope.base
      ? list
      : async () => {
          const success = await list()
          // The folder's configured default stays with the folder's own entry.
          if (success.complete === true && current()) {
            const { models, origin, fastModeSupport } = success
            deps.store.recordSuccess(
              scope.base,
              agent,
              { models, origin, complete: true, ...(fastModeSupport ? { fastModeSupport } : {}) },
              'discovery'
            )
          }
          return success
        }
}

/** Before a read's scope resolves, answer from the account's list rather than nothing; it names no default. */
export async function readAccountList(
  deps: AgentModelCatalogServiceDeps,
  params: AgentModelCatalogReadParams,
  snapshot: (params: AgentModelCatalogReadParams) => AgentSessionModelCatalogResult
): Promise<AgentSessionModelCatalogResult> {
  const result = snapshot(params)
  if (
    result.origin !== 'unknown' ||
    params.savedOnly ||
    params.verifiedOnly ||
    params.legacy ||
    !independentAgentModelCatalog(params.agent)
  ) {
    return result
  }
  const record = params.sessionId ? deps.getConversation(params.sessionId) : undefined
  const base = record
    ? record.provider === params.agent &&
      deps.drivesRecord(record) &&
      isNativeLocalLocation(record.location)
      ? agentModelCatalogFingerprintForRecord(record)
      : null
    : (await newChatCatalogKey(deps, params.agent))?.fingerprint
  const latest = snapshot(params)
  const entry = base && latest.origin === 'unknown' ? deps.store.observation(base) : null
  return entry
    ? {
        ...agentModelCatalogResultFromEntry(entry, false, false, false),
        modelsDifferByWorkspace: true,
        ...(latest.listingInProgress ? { listingInProgress: true as const } : {})
      }
    : latest
}
