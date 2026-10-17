import { isLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { homedir } from 'node:os'
import { createAgentModelCatalogProcessObservations } from './agent-model-catalog-process-observations'
import type {
  AgentSessionChoiceCatalog,
  AgentSessionModelCatalogResult
} from '../../../shared/agent-session-wire'
import { isNativeLocalLocation } from '../../../shared/execution-host'
import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogFingerprintForRecord,
  agentModelCatalogScopeFingerprint
} from './agent-model-catalog-fingerprint'
import {
  agentModelCatalogResultFromEntry,
  agentModelCatalogSessionObservation,
  retainedAgentModelCatalogModels
} from './agent-model-catalog-entry'
import type { AgentModelCatalogEntry } from './agent-model-catalog-store'
import { AgentModelCatalogListingStoppedError } from './agent-model-catalog-failures'

import type {
  AgentModelCatalogRead,
  AgentModelCatalogService,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'
export type {
  AgentModelCatalogService,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'

export function createAgentModelCatalogService(
  deps: AgentModelCatalogServiceDeps
): AgentModelCatalogService {
  const lifetime = new AbortController()
  const admission = new PrioritySemaphore(2)
  const sessionKeys = new Map<string, string>()
  const processes = createAgentModelCatalogProcessObservations(deps)
  const processCatalog = processes.read
  const read = async (params: AgentModelCatalogRead): Promise<AgentSessionModelCatalogResult> => {
    const unverified = (): AgentSessionModelCatalogResult => ({
      origin: 'unknown',
      choiceCatalog: params.sessionId
        ? (processCatalog(params.sessionId) ?? {
            authority: 'discovery',
            scopeId: '',
            models: [],
            complete: false,
            freshForMs: 0
          })
        : { authority: 'discovery', scopeId: '', models: [], complete: false, freshForMs: 0 }
    })
    const record = params.sessionId ? deps.getRecord(params.sessionId) : undefined
    if (
      record &&
      (record.provider !== params.agent ||
        !deps.drivesRecord(record) ||
        !isNativeLocalLocation(record.location))
    ) {
      return {
        origin: 'unknown',
        choiceCatalog: {
          authority: 'session',
          scopeId: params.sessionId ?? '',
          models: [],
          complete: false,
          freshForMs: 0
        }
      }
    }
    const home =
      record?.accountHome ?? (await deps.resolveAccountHome(params.agent).catch(() => null))
    if (!home) {
      return unverified()
    }
    const base = agentModelCatalogFingerprint({
      agent: params.agent,
      accountHome: home,
      wslDistro: null
    })
    const cwd = params.accountDefault
      ? homedir()
      : params.workspacePath === null
        ? null
        : (params.workspacePath ??
          (record ? await deps.recordWorkspacePath?.(record).catch(() => null) : homedir()))
    if (!cwd) {
      const legacy = deps.store.get(base)
      if (!legacy) {
        return unverified()
      }
      return {
        ...agentModelCatalogResultFromEntry(legacy, false, false),
        ...unverified(),
        origin: legacy.origin,
        models: legacy.models.map((row) => ({ ...row, isDefault: false })),
        fetchedAt: legacy.fetchedAt
      }
    }
    const namesDefault =
      params.accountDefault || (params.workspacePath === undefined && !params.inSessionWorkspace)
        ? true
        : deps.workspaceMayOverrideDefaultModel
          ? !(await deps
              .workspaceMayOverrideDefaultModel({
                agent: params.agent,
                workspacePath: cwd,
                accountHomePath: isLegacyAgentSessionAccountHome(home) ? home.path : null
              })
              .catch(() => true))
          : false
    const probe = deps.probes?.[params.agent]
    const resolved = await probe
      ?.resolve?.(home, cwd, params.accountDefault ? undefined : record?.options)
      .catch(() => null)
    if (probe?.resolve && !resolved) {
      return unverified()
    }
    const fingerprint = agentModelCatalogScopeFingerprint(base, cwd, resolved?.identity)
    if (params.sessionId && !params.accountDefault) {
      if (sessionKeys.size >= 256 && !sessionKeys.has(params.sessionId)) {
        const oldest = sessionKeys.keys().next().value
        if (oldest !== undefined) {
          sessionKeys.delete(oldest)
        }
      }
      sessionKeys.set(params.sessionId, fingerprint)
      const process = processes.get(params.sessionId)
      if (
        record &&
        process &&
        record.provider !== 'claude' &&
        record.provider !== 'codex' &&
        process.scope === deps.processScope?.(params.sessionId)
      ) {
        deps.store.recordSuccess(
          fingerprint,
          record.provider,
          agentModelCatalogSessionObservation(process.listing),
          'live'
        )
      }
    }
    let entry = deps.store.get(fingerprint)
    // Old cache identities remain usable only through the legacy flat display contract.
    const legacy = entry ? null : deps.store.get(base)
    const answer = (
      listed: AgentModelCatalogEntry | null,
      listingInProgress = false
    ): AgentSessionModelCatalogResult => {
      const unavailable = deps.store.failure(fingerprint)?.unavailable
      const process = params.sessionId ? processCatalog(params.sessionId) : null
      const observation = listed?.observation
      const discovery = params.agent === 'claude' || params.agent === 'codex'
      const choiceCatalog: AgentSessionChoiceCatalog = process ?? {
        authority: 'discovery',
        scopeId: fingerprint,
        models: observation?.models ?? [],
        complete:
          discovery &&
          listed?.source === 'discovery' &&
          observation?.complete === true &&
          !unavailable,
        freshForMs: discovery && listed && !unavailable ? deps.store.freshForMs(listed) : 0,
        ...(observation?.configured ? { configured: observation.configured } : {}),
        ...(observation?.fastModeSupport ? { fastModeSupport: observation.fastModeSupport } : {})
      }
      const display = listed ?? legacy
      const result = display
        ? agentModelCatalogResultFromEntry(
            display,
            namesDefault,
            deps.listingNamesConfiguredModel?.has(params.agent) === true
          )
        : null
      return {
        ...(result ?? { origin: 'unknown' as const }),
        ...(result?.listingNamesConfiguredModel === true &&
        deps.agentReadsProjectModelConfig?.(params.agent) === false
          ? { defaultHoldsInEveryWorkspace: true as const }
          : {}),
        choiceCatalog,
        ...(listingInProgress ? { listingInProgress: true as const } : {}),
        ...(unavailable ? { unavailable } : {})
      }
    }
    if (
      params.savedOnly ||
      (record?.lease?.claimStatus === 'released' && record.lease.deathEvidence)
    ) {
      return answer(entry)
    }
    if (probe && !lifetime.signal.aborted && deps.store.probeDue(fingerprint)) {
      deps.store.refresh(fingerprint, params.agent, probe, async () => {
        try {
          const release = await admission.acquire(0, lifetime.signal)
          try {
            const result = resolved
              ? await resolved.run(lifetime.signal)
              : await probe(home, { cwd, signal: lifetime.signal })
            return params.agent === 'claude' || params.agent === 'codex'
              ? result
              : { ...result, advisory: true as const }
          } finally {
            release()
          }
        } catch (error) {
          if (lifetime.signal.aborted) {
            throw new AgentModelCatalogListingStoppedError(String(error))
          }
          throw error
        }
      })
    }
    if (params.waitForListing && deps.store.isListing(fingerprint)) {
      await deps.store.pendingListing(fingerprint, entry)
      entry = deps.store.get(fingerprint)
    }
    return answer(entry, deps.store.isListing(fingerprint))
  }
  return {
    read,
    processCatalog,
    peek: (sessionId) => deps.store.get(sessionKeys.get(sessionId) ?? ''),
    providerStarted(record) {
      const key = sessionKeys.get(record.sessionId)
      if (key) {
        deps.store.expireFailure(key)
      }
      deps.store.expireFailure(agentModelCatalogFingerprintForRecord(record))
    },
    retainedLiveModelIds(sessionId, listing) {
      return retainedAgentModelCatalogModels(
        deps.store.get(sessionKeys.get(sessionId) ?? ''),
        listing
      ).map((model) => model.id)
    },
    recordLiveListing(sessionId, listing) {
      const record = deps.getRecord(sessionId)
      const scope = deps.processScope?.(sessionId)
      if (!record || !deps.drivesRecord(record) || record.provider === 'codex') {
        return
      }
      processes.record(sessionId, scope, listing)
      // Claude's no-live route is independent discovery, never a previous process snapshot.
      const fingerprint = sessionKeys.get(sessionId)
      if (fingerprint && record.provider !== 'claude') {
        deps.store.recordSuccess(
          fingerprint,
          record.provider,
          agentModelCatalogSessionObservation(listing),
          'live'
        )
      } else if (record.provider !== 'claude') {
        void read({ agent: record.provider, sessionId, savedOnly: true }).catch(() => {})
      }
    },
    async prewarm() {
      if (lifetime.signal.aborted) {
        return
      }
      await Promise.all(
        Object.keys(deps.probes ?? {})
          .filter((agent) => deps.store.hasEntryForAgent(agent) || deps.hasChatRecords?.(agent))
          .map((agent) => read({ agent, waitForListing: true }).catch(() => {}))
      )
    },
    stop() {
      lifetime.abort()
      processes.clear()
      sessionKeys.clear()
    }
  }
}
