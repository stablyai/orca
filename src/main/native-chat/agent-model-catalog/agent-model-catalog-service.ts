import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type {
  AgentSessionAccountHome,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import { isLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogFingerprintForRecord
} from './agent-model-catalog-fingerprint'
import type {
  AgentModelCatalogEntry,
  AgentModelCatalogProbe,
  AgentModelCatalogStore
} from './agent-model-catalog-store'

export type AgentModelCatalogServiceDeps = {
  store: AgentModelCatalogStore
  getRecord: (sessionId: string) => AgentSessionRecord | undefined
  /** Whether this build can start the record's agent as the record pins it; a record it cannot
   *  names no account a probe may start that agent's CLI under. */
  drivesRecord: (record: AgentSessionRecord) => boolean
  /** The account home a structured launch for this agent would pin right now —
   *  the SAME resolver the create path fills `record.accountHome` with, so a
   *  record-less read can never answer from another account's listing. */
  resolveAccountHome: (agent: string) => Promise<AgentSessionAccountHome>
  /** Session-less listers, one per agent that has one on this host. */
  probes?: Readonly<Partial<Record<string, AgentModelCatalogProbe>>>
  /** Whether the workspace's own config could pick a model other than the listed default. */
  workspaceMayOverrideDefaultModel?: (input: {
    agent: string
    workspacePath: string
    accountHomePath: string
  }) => Promise<boolean>
}

export type AgentModelCatalogService = {
  read: (params: {
    agent: string
    sessionId?: string
    /** Where a new chat would run; null when one was named but is not a local directory. */
    workspacePath?: string | null
    /** With no entry yet, answer from the listing this read starts or joins instead of `unknown`;
     *  with a held reason past its TTL, from the probe re-checking it. */
    waitForListing?: boolean
  }) => Promise<AgentSessionModelCatalogResult>
  /** A chat under this record's account proved its start: a held reason is re-checked sooner. */
  providerStarted: (
    record: Pick<AgentSessionRecord, 'provider' | 'accountHome' | 'location'>
  ) => void
}

function resultFromEntry(
  entry: AgentModelCatalogEntry,
  namesDefault: boolean
): AgentSessionModelCatalogResult {
  return {
    origin: entry.origin,
    // Without a default the picker names nothing until the chat reports its model.
    models: entry.models.map((model) =>
      namesDefault ? { ...model } : { ...model, isDefault: false }
    ),
    ...(entry.fastModeSupport ? { fastModeSupport: entry.fastModeSupport } : {}),
    fetchedAt: entry.fetchedAt
  }
}

/** A named workspace keeps the listed default only when none of its own config can replace it. */
async function workspaceKeepsListedDefault(
  deps: AgentModelCatalogServiceDeps,
  agent: string,
  workspacePath: string | null | undefined,
  accountHomePath: string | null
): Promise<boolean> {
  if (workspacePath === undefined) {
    return true
  }
  if (workspacePath === null || !accountHomePath || !deps.workspaceMayOverrideDefaultModel) {
    return false
  }
  try {
    return !(await deps.workspaceMayOverrideDefaultModel({ agent, workspacePath, accountHomePath }))
  } catch {
    return false
  }
}

/**
 * Serves the host catalog to pickers, never through a session's serialize
 * queue. A session record names its own catalog (the account home pinned at
 * launch); without one, the key is the account a launch would pin right now —
 * never "whichever account listed last". `unknown` tells the client to keep
 * its static seed, and a missing or aged entry kicks one joined background
 * probe so the next read is warm. With no entry, the answer says that listing
 * is running, and only a read that asks waits for it. Failures suppress a new
 * probe for 30s, but never hide another listing already running for the account.
 * A probe failure that says why no chat can start rides every answer as
 * `unavailable` until a later probe answers again.
 */
export function createAgentModelCatalogService(
  deps: AgentModelCatalogServiceDeps
): AgentModelCatalogService {
  return {
    providerStarted(record) {
      deps.store.expireFailure(agentModelCatalogFingerprintForRecord(record))
    },
    async read(params) {
      const record = params.sessionId ? deps.getRecord(params.sessionId) : undefined
      const scoped =
        record && record.provider === params.agent && deps.drivesRecord(record) ? record : undefined
      let fingerprint: string
      let accountHomePath: string | null
      if (scoped) {
        fingerprint = agentModelCatalogFingerprintForRecord(scoped)
        // Probes spawn natively; a WSL-pinned record has no host-side lister.
        accountHomePath =
          scoped.location.wslDistro === null && isLegacyAgentSessionAccountHome(scoped.accountHome)
            ? scoped.accountHome.path
            : null
      } else {
        let resolved: AgentSessionAccountHome
        try {
          resolved = await deps.resolveAccountHome(params.agent)
        } catch {
          return { origin: 'unknown' }
        }
        fingerprint = agentModelCatalogFingerprint({
          agent: params.agent,
          accountHome: resolved,
          wslDistro: null
        })
        accountHomePath = isLegacyAgentSessionAccountHome(resolved) ? resolved.path : null
      }
      let entry = deps.store.get(fingerprint)
      const probe = deps.probes?.[params.agent]
      const home = accountHomePath
      // Every answer carries the reason the probe last found, read when the answer is made.
      const answer = async (
        listed: AgentModelCatalogEntry | null,
        extra: { listingInProgress?: true } = {}
      ): Promise<AgentSessionModelCatalogResult> => {
        const unavailable = deps.store.failure(fingerprint)?.unavailable
        return {
          ...(listed
            ? resultFromEntry(
                listed,
                await workspaceKeepsListedDefault(
                  deps,
                  params.agent,
                  params.workspacePath,
                  accountHomePath
                )
              )
            : { origin: 'unknown' }),
          ...extra,
          ...(unavailable ? { unavailable } : {})
        }
      }
      // Past its TTL, only the probe re-derives a held reason. The reason is served meanwhile;
      // only a read that asks waits for the probe's answer.
      if (
        probe &&
        home &&
        deps.store.failure(fingerprint)?.unavailable &&
        !deps.store.hasActiveFailure(fingerprint)
      ) {
        const probing = deps.store.refresh(fingerprint, params.agent, probe, () => probe(home))
        if (!params.waitForListing) {
          return answer(entry, { listingInProgress: true })
        }
        await probing
        return answer(deps.store.get(fingerprint))
      }
      // Without an entry, answer from any running listing instead of starting a second one.
      let listing = !entry && home ? deps.store.pendingListing(fingerprint) : null
      if (probe && home) {
        if (entry && deps.store.shouldRefresh(fingerprint)) {
          void deps.store.refresh(fingerprint, params.agent, probe, () => probe(home))
        } else if (!entry && !listing && !deps.store.hasActiveFailure(fingerprint)) {
          void deps.store.refresh(fingerprint, params.agent, probe, () => probe(home))
          listing = deps.store.pendingListing(fingerprint)
        }
      }
      if (!entry) {
        if (!listing) {
          return answer(null)
        }
        if (!params.waitForListing) {
          return answer(null, { listingInProgress: true })
        }
        const listed = await listing
        entry = deps.store.get(fingerprint) ?? listed
      }
      return answer(entry)
    }
  }
}
