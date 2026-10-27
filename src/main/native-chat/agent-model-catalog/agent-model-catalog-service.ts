import {
  agentModelCatalogProbeLister,
  scopedAgentModelCatalogLister
} from './agent-model-catalog-lister'
import { prewarmAgentModelCatalog, newChatCatalogKey } from './agent-model-catalog-prewarm'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-record'
import { isLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import {
  agentModelCatalogResultFromEntry,
  retainedAgentModelCatalogModels
} from './agent-model-catalog-entry'
import type { AgentModelCatalogEntry } from './agent-model-catalog-store'
import {
  catalogFolder,
  createAgentModelCatalogLiveListingRecorder,
  sessionWorkspacePath,
  type AgentModelCatalogRecord,
  workspaceKeepsListedDefault
} from './agent-model-catalog-workspace'

import type {
  AgentModelCatalogServiceDeps,
  AgentModelCatalogService
} from './agent-model-catalog-service-contract'
export type { AgentModelCatalogServiceDeps, AgentModelCatalogService }
import { resolveAgentModelCatalogScope } from './agent-model-catalog-scope'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import { PrioritySemaphore } from '../../../shared/priority-semaphore'

/** Keep picker discovery outside session queues and key it to the launched/selected account.
 * Probe unavailability persists until another probe answers, independently of live model listings. */
export function createAgentModelCatalogService(
  deps: AgentModelCatalogServiceDeps
): AgentModelCatalogService {
  const lifetime = new AbortController()
  const admission = new PrioritySemaphore(2)
  const sessionKeys = new Map<string, string>()
  // Reads await configured-default recording so they reflect the reporting chat's resolution.
  const recordingDefaults = new Map<string, Promise<void>>()
  const listWith = agentModelCatalogProbeLister(lifetime.signal)
  // Serialize folder-scoped writes across asynchronous folder lookups.
  const liveWrites = new Map<string, Promise<void>>()
  const sessionCatalogKey = async (record: AgentModelCatalogRecord): Promise<string> =>
    agentModelCatalogFingerprintForRecord(
      record,
      await catalogFolder(deps, record.provider, undefined, record)
    )
  const saveLiveListing = createAgentModelCatalogLiveListingRecorder(deps, recordingDefaults)
  return {
    peek(sessionId, verifiedOnly) {
      const key = sessionKeys.get(sessionId)
      const entry = key ? deps.store.get(key) : null
      return entry && (!verifiedOnly || deps.store.verified(entry)) ? entry : null
    },
    providerStarted(record) {
      const key = sessionKeys.get(record.sessionId)
      if (key) {
        deps.store.expireFailure(key)
      }
      if (!deps.listsInChatFolder?.has(record.provider)) {
        deps.store.expireFailure(agentModelCatalogFingerprintForRecord(record))
        return
      }
      void sessionCatalogKey(record)
        .then((fingerprint) => {
          if (deps.getRecord(record.sessionId)?.lease.runtimeFence === record.lease.runtimeFence) {
            deps.store.expireFailure(fingerprint)
          }
        })
        .catch(() => {})
    },
    async read(params) {
      const record = params.sessionId ? deps.getConversation(params.sessionId) : undefined
      const savedOnly = params.savedOnly || !!(record && !deps.getRecord(record.sessionId))
      const scoped =
        record && record.provider === params.agent && deps.drivesRecord(record) ? record : undefined
      const workspacePath = params.inSessionWorkspace
        ? record
          ? await sessionWorkspacePath(deps, record)
          : null
        : params.workspacePath
      const folder = await catalogFolder(deps, params.agent, workspacePath, scoped)
      let fingerprint: string
      let probeHome: AgentSessionAccountHome | null
      if (scoped) {
        fingerprint = agentModelCatalogFingerprintForRecord(scoped, folder)
        // Native probes cannot list a WSL-pinned account.
        probeHome =
          scoped.location.executionHostId === 'local' && scoped.location.wslDistro === null
            ? scoped.accountHome
            : null
      } else {
        const key = await newChatCatalogKey(deps, params.agent, folder)
        if (!key) {
          return { origin: 'unknown' }
        }
        fingerprint = key.fingerprint
        probeHome = key.accountHome
      }
      const scope = await resolveAgentModelCatalogScope(
        deps,
        { ...params, savedOnly },
        scoped,
        fingerprint,
        probeHome
      )
      if (!scope) {
        return { origin: 'unknown' }
      }
      const { base, exact, resolved, cwd } = scope
      fingerprint = scope.fingerprint
      if (scoped && exact) {
        if (sessionKeys.size >= 256 && !sessionKeys.has(scoped.sessionId)) {
          const oldest = sessionKeys.keys().next().value
          if (oldest !== undefined) {
            sessionKeys.delete(oldest)
          }
        }
        sessionKeys.set(scoped.sessionId, fingerprint)
      }
      const accountHomePath =
        probeHome && isLegacyAgentSessionAccountHome(probeHome) ? probeHome.path : null
      await Promise.all(liveWrites.values())
      await recordingDefaults.get(fingerprint)
      let entry = deps.store.get(fingerprint)
      const probe = deps.probes?.[params.agent]
      const list = scopedAgentModelCatalogLister({
        legacy: params.legacy,
        canList: () => !record || !!deps.getRecord(record.sessionId),
        admission,
        signal: lifetime.signal,
        resolved,
        probe,
        probeHome,
        workspacePath: cwd ?? folder
      })
      const answer = async (
        listed: AgentModelCatalogEntry | null,
        extra: { listingInProgress?: true } = {}
      ): Promise<AgentSessionModelCatalogResult> => {
        if (
          params.verifiedOnly &&
          (!listed ||
            (independentAgentModelCatalog(params.agent) &&
              (!exact || !deps.store.verified(listed))))
        ) {
          return { origin: 'unknown' }
        }
        const display = listed ?? (exact && !params.verifiedOnly ? deps.store.get(base) : null)
        const independent = independentAgentModelCatalog(params.agent)
        const accountFallback =
          independent &&
          scoped &&
          params.savedOnly &&
          params.workspacePath === null &&
          !params.inSessionWorkspace
        const result = display
          ? agentModelCatalogResultFromEntry(
              display,
              independent &&
                !params.legacyOptionsDisplay &&
                (!deps.store.verified(display) || (!exact && !params.legacy))
                ? false
                : exact && listed !== null && deps.store.verified(listed)
                  ? true
                  : await workspaceKeepsListedDefault(
                      deps,
                      params.agent,
                      accountFallback ? undefined : workspacePath,
                      accountHomePath
                    ),
              deps.listingNamesConfiguredModel?.has(params.agent) === true,
              !independent || (exact && listed !== null && deps.store.verified(listed))
            )
          : null
        const holdsEverywhere =
          result?.listingNamesConfiguredModel === true &&
          deps.agentReadsProjectModelConfig?.(params.agent) === false
        return {
          ...(result ?? { origin: 'unknown' }),
          ...extra,
          ...(holdsEverywhere ? { defaultHoldsInEveryWorkspace: true as const } : {}),
          ...(result && (folder !== undefined || exact)
            ? { modelsDifferByWorkspace: true as const }
            : {}),
          ...(!params.savedOnly &&
          !params.verifiedOnly &&
          deps.store.isListing(fingerprint) &&
          (independent || !listed)
            ? { listingInProgress: true as const }
            : {}),
          ...(deps.store.failure(fingerprint)?.unavailable
            ? { unavailable: deps.store.failure(fingerprint)?.unavailable }
            : {})
        }
      }
      // Observed process exit suppresses background relaunch; explicit new chats may discover.
      if (
        savedOnly ||
        (scoped && !deps.getRecord(scoped.sessionId)) ||
        (!exact &&
          scoped?.ownerObservation.claimStatus === 'released' &&
          scoped.ownerObservation.deathEvidence)
      ) {
        return answer(entry)
      }
      if (probe && probeHome && !lifetime.signal.aborted && deps.store.heldReasonDue(fingerprint)) {
        void deps.store.refresh(fingerprint, params.agent, probe, list)
        if (!params.waitForListing) {
          return answer(entry, { listingInProgress: true })
        }
        await deps.store.pendingListing(fingerprint, true, params.legacy)
        return answer(deps.store.get(fingerprint))
      }
      let listing =
        !entry && probeHome ? deps.store.pendingListing(fingerprint, false, params.legacy) : null
      if (probe && probeHome && !lifetime.signal.aborted) {
        if (entry && deps.store.shouldRefresh(fingerprint)) {
          void deps.store.refresh(fingerprint, params.agent, probe, list)
        } else if (!entry && !listing && deps.store.shouldRefresh(fingerprint)) {
          void deps.store.refresh(fingerprint, params.agent, probe, list)
          listing = deps.store.pendingListing(fingerprint, false, params.legacy)
        }
      }
      if (
        entry &&
        independentAgentModelCatalog(params.agent) &&
        deps.store.isListing(fingerprint)
      ) {
        if (!params.waitForListing) {
          return answer(entry)
        }
        await deps.store.pendingListing(fingerprint, true, params.legacy)
        return answer(deps.store.get(fingerprint))
      }
      if (!entry) {
        if (!listing) {
          return answer(null)
        }
        if (!params.waitForListing) {
          return answer(null)
        }
        const listed = await listing
        entry = deps.store.get(fingerprint) ?? listed
      }
      return answer(entry)
    },
    async retainedLiveModelIds(sessionId, listing) {
      const record = deps.getConversation(sessionId)
      const entry =
        record && deps.drivesRecord(record)
          ? deps.store.get(await sessionCatalogKey(record))
          : undefined
      return retainedAgentModelCatalogModels(entry, listing).map((model) => model.id)
    },
    recordLiveListing(sessionId, listing) {
      const record = deps.getRecord(sessionId)
      if (!record || !deps.drivesRecord(record) || independentAgentModelCatalog(record.provider)) {
        return
      }
      if (!deps.listsInChatFolder?.has(record.provider)) {
        saveLiveListing(record, listing, agentModelCatalogFingerprintForRecord(record))
        return
      }
      // Serialize reports so a slow folder lookup cannot overwrite a newer listing.
      const writing = (liveWrites.get(sessionId) ?? Promise.resolve())
        .then(async () => {
          const fingerprint = await sessionCatalogKey(record)
          if (deps.getRecord(sessionId)?.lease.runtimeFence === record.lease.runtimeFence) {
            saveLiveListing(record, listing, fingerprint)
          }
        })
        .catch((error: unknown) => {
          console.warn('[agent-model-catalog] could not save a chat model list:', error)
        })
        .finally(() => {
          if (liveWrites.get(sessionId) === writing) {
            liveWrites.delete(sessionId)
          }
        })
      liveWrites.set(sessionId, writing)
    },
    async prewarm() {
      await prewarmAgentModelCatalog(deps, lifetime.signal, (params) => this.read(params), listWith)
    },
    stop() {
      lifetime.abort()
      sessionKeys.clear()
      deps.store.clearPartialAttempts()
    }
  }
}
