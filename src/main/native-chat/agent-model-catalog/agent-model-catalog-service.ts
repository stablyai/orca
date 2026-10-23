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
import {
  agentModelCatalogResultFromEntry,
  retainedAgentModelCatalogModels
} from './agent-model-catalog-entry'
import type {
  AgentModelCatalogEntry,
  AgentModelCatalogLiveListing,
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from './agent-model-catalog-store'
import { AgentModelCatalogListingStoppedError } from './agent-model-catalog-failures'
import {
  catalogFolder,
  recordConfiguredDefault,
  sessionWorkspacePath,
  workspaceKeepsListedDefault,
  type AgentModelCatalogWorkspaceDeps
} from './agent-model-catalog-workspace'

export type AgentModelCatalogServiceDeps = AgentModelCatalogWorkspaceDeps & {
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
  /** Agents whose listing marks the model the account is configured to run as its default. */
  listingNamesConfiguredModel?: ReadonlySet<string>
  /** False for an agent whose model no project config can pick; its default holds everywhere. */
  agentReadsProjectModelConfig?: (agent: string) => boolean
  /** Whether this host keeps any chat of the agent; with a saved catalog, what marks it in use. */
  hasChatRecords?: (agent: string) => boolean
}

export type AgentModelCatalogService = {
  read: (params: {
    agent: string
    sessionId?: string
    /** Where a new chat would run; null when one was named but is not a local directory. */
    workspacePath?: string | null
    /** Answer for the folder the named session runs in, as its new-chat read did. */
    inSessionWorkspace?: true
    /** With no entry yet, answer from the listing this read starts or joins instead of `unknown`;
     *  with a held reason past its TTL, from the probe re-checking it. */
    waitForListing?: boolean
    /** Answer only from the saved entry and held reason; start, join or re-check no listing. */
    savedOnly?: boolean
  }) => Promise<AgentSessionModelCatalogResult>
  /** Incoming listing ids, checking only a launch-added row against the pinned account. */
  retainedLiveModelIds: (
    sessionId: string,
    listing: AgentModelCatalogLiveListing
  ) => Promise<string[]>
  /** Saves a session's listing and newly learned menus so the next chat starts warm. */
  recordLiveListing: (sessionId: string, listing: AgentModelCatalogLiveListing) => void
  /** Lists, in the background, every agent the user has used here (a saved catalog or a chat)
   *  whose catalog for the account a new chat would pin is missing or old, so a picker never meets
   *  a cold catalog. Resolves once those listings settle. */
  prewarm: () => Promise<void>
  /** The host is going away: start no listing, and stop the ones running. */
  stop: () => void
  /** A chat under this record's account proved its start: a held reason is re-checked sooner. */
  providerStarted: (record: AgentSessionRecord) => void
}

// At most this many agents list at once: each listing spawns that agent's CLI.
const PREWARM_CONCURRENCY = 2

/** The catalog a new chat of `agent` would read: the account a launch would pin right now. */
async function newChatCatalogKey(
  deps: AgentModelCatalogServiceDeps,
  agent: string,
  folder?: string
): Promise<{ fingerprint: string; accountHome: AgentSessionAccountHome } | null> {
  let accountHome: AgentSessionAccountHome
  try {
    accountHome = await deps.resolveAccountHome(agent)
  } catch {
    return null
  }
  return {
    fingerprint: agentModelCatalogFingerprint({ agent, accountHome, wslDistro: null, folder }),
    accountHome
  }
}

async function runBounded<T>(
  items: readonly T[],
  limit: number,
  stopped: AbortSignal,
  run: (item: T) => Promise<unknown>
): Promise<void> {
  const queue = [...items]
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined && !stopped.aborted; item = queue.shift()) {
      await run(item).catch(() => {})
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker))
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
  // One per host: stopping it ends every listing this service started.
  const lifetime = new AbortController()
  // A chat's configured default still being checked against its workspace, per catalog: a read
  // answers after it, so the chat that reported it is followed by an answer naming it.
  const recordingDefaults = new Map<string, Promise<void>>()
  const listWith =
    (probe: AgentModelCatalogProbe, home: AgentSessionAccountHome, workspacePath?: string) =>
    (): Promise<AgentModelCatalogSuccess> =>
      probe(home, { signal: lifetime.signal, workspacePath }).catch((error: unknown) => {
        throw lifetime.signal.aborted
          ? new AgentModelCatalogListingStoppedError(String(error))
          : error
      })
  // A running chat's saves for agents kept per folder, which wait on a folder lookup.
  const liveWrites = new Map<string, Promise<void>>()
  /** The catalog a session's own listings belong to: its pinned account and host, and its folder
   *  for an agent kept per folder. */
  const sessionCatalogKey = async (record: AgentSessionRecord): Promise<string> =>
    agentModelCatalogFingerprintForRecord(
      record,
      await catalogFolder(deps, record.provider, undefined, record)
    )
  const saveLiveListing = (
    record: AgentSessionRecord,
    listing: AgentModelCatalogLiveListing,
    fingerprint: string
  ): void => {
    const { configuredDefault, ...listed } = listing
    const saved = deps.store.recordSuccess(
      fingerprint,
      record.provider,
      { ...listed, origin: 'live-session' },
      'live'
    )
    if (saved && configuredDefault !== undefined) {
      // In report order, so the latest chat's resolution is the one kept.
      const recording = (recordingDefaults.get(fingerprint) ?? Promise.resolve())
        .then(() => recordConfiguredDefault(deps, record, fingerprint, configuredDefault))
        .catch(() => {})
        .then(() => {
          if (recordingDefaults.get(fingerprint) === recording) {
            recordingDefaults.delete(fingerprint)
          }
        })
      recordingDefaults.set(fingerprint, recording)
    }
  }
  return {
    providerStarted(record) {
      if (!deps.listsInChatFolder?.has(record.provider)) {
        deps.store.expireFailure(agentModelCatalogFingerprintForRecord(record))
        return
      }
      void sessionCatalogKey(record)
        .then((fingerprint) => deps.store.expireFailure(fingerprint))
        .catch(() => {})
    },
    async read(params) {
      const record = params.sessionId ? deps.getRecord(params.sessionId) : undefined
      const scoped =
        record && record.provider === params.agent && deps.drivesRecord(record) ? record : undefined
      const workspacePath = params.inSessionWorkspace
        ? record
          ? await sessionWorkspacePath(deps, record)
          : null
        : params.workspacePath
      const folder = await catalogFolder(deps, params.agent, workspacePath, scoped)
      let fingerprint: string
      // The account a probe lists under; null where this host cannot spawn one natively.
      let probeHome: AgentSessionAccountHome | null
      if (scoped) {
        fingerprint = agentModelCatalogFingerprintForRecord(scoped, folder)
        // Probes spawn natively; a WSL-pinned record has no host-side lister.
        probeHome = scoped.location.wslDistro === null ? scoped.accountHome : null
      } else {
        const key = await newChatCatalogKey(deps, params.agent, folder)
        if (!key) {
          return { origin: 'unknown' }
        }
        fingerprint = key.fingerprint
        probeHome = key.accountHome
      }
      const accountHomePath =
        probeHome && isLegacyAgentSessionAccountHome(probeHome) ? probeHome.path : null
      // A chat's report still finding its folder lands first, as it would have before the read.
      await Promise.all(liveWrites.values())
      await recordingDefaults.get(fingerprint)
      let entry = deps.store.get(fingerprint)
      const probe = deps.probes?.[params.agent]
      const home = probeHome
      // Every answer carries the reason the probe last found, read when the answer is made.
      const answer = async (
        listed: AgentModelCatalogEntry | null,
        extra: { listingInProgress?: true } = {}
      ): Promise<AgentSessionModelCatalogResult> => {
        const unavailable = deps.store.failure(fingerprint)?.unavailable
        const result = listed
          ? agentModelCatalogResultFromEntry(
              listed,
              await workspaceKeepsListedDefault(deps, params.agent, workspacePath, accountHomePath),
              deps.listingNamesConfiguredModel?.has(params.agent) === true
            )
          : null
        const holdsEverywhere =
          result?.listingNamesConfiguredModel === true &&
          deps.agentReadsProjectModelConfig?.(params.agent) === false
        return {
          ...(result ?? { origin: 'unknown' }),
          ...(holdsEverywhere ? { defaultHoldsInEveryWorkspace: true as const } : {}),
          ...(result && folder !== undefined ? { modelsDifferByWorkspace: true as const } : {}),
          ...extra,
          ...(unavailable ? { unavailable } : {})
        }
      }
      // Death evidence keeps a read after an observed exit from spawning another agent; a new chat
      // also starts released, but still needs its first listing.
      if (
        params.savedOnly ||
        (scoped?.lease?.claimStatus === 'released' && scoped.lease.deathEvidence)
      ) {
        return answer(entry)
      }
      // Past its TTL, only the probe re-derives a held reason. The reason is served meanwhile;
      // only a read that asks waits for the probe's answer.
      if (probe && home && !lifetime.signal.aborted && deps.store.heldReasonDue(fingerprint)) {
        const probing = deps.store.refresh(
          fingerprint,
          params.agent,
          probe,
          listWith(probe, home, folder)
        )
        if (!params.waitForListing) {
          return answer(entry, { listingInProgress: true })
        }
        await probing
        return answer(deps.store.get(fingerprint))
      }
      // Without an entry, answer from any running listing instead of starting a second one.
      let listing = !entry && home ? deps.store.pendingListing(fingerprint) : null
      if (probe && home && !lifetime.signal.aborted) {
        if (entry && deps.store.shouldRefresh(fingerprint)) {
          void deps.store.refresh(fingerprint, params.agent, probe, listWith(probe, home, folder))
        } else if (!entry && !listing && !deps.store.hasActiveFailure(fingerprint)) {
          void deps.store.refresh(fingerprint, params.agent, probe, listWith(probe, home, folder))
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
    },
    async retainedLiveModelIds(sessionId, listing) {
      const record = deps.getRecord(sessionId)
      const entry =
        record && deps.drivesRecord(record)
          ? deps.store.get(await sessionCatalogKey(record))
          : undefined
      return retainedAgentModelCatalogModels(entry, listing).map((model) => model.id)
    },
    recordLiveListing(sessionId, listing) {
      const record = deps.getRecord(sessionId)
      if (!record || !deps.drivesRecord(record)) {
        return
      }
      if (!deps.listsInChatFolder?.has(record.provider)) {
        saveLiveListing(record, listing, agentModelCatalogFingerprintForRecord(record))
        return
      }
      // In report order: a folder lookup that resolves late must not let an older listing land last.
      const writing = (liveWrites.get(sessionId) ?? Promise.resolve())
        .then(async () => saveLiveListing(record, listing, await sessionCatalogKey(record)))
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
      if (lifetime.signal.aborted) {
        return
      }
      const probes = deps.probes ?? {}
      // An agent never used here waits for its first chat, which shows the quiet placeholder.
      const used = Object.keys(probes).filter(
        (agent) =>
          !deps.listsInChatFolder?.has(agent) &&
          (deps.store.hasEntryForAgent(agent) || deps.hasChatRecords?.(agent) === true)
      )
      await runBounded(used, PREWARM_CONCURRENCY, lifetime.signal, async (agent) => {
        const probe = probes[agent]
        const key = probe ? await newChatCatalogKey(deps, agent) : null
        // A fresh entry, a listing already running, or a recent failure each mean nothing to do.
        if (!probe || !key || lifetime.signal.aborted || !deps.store.probeDue(key.fingerprint)) {
          return
        }
        await deps.store.refresh(key.fingerprint, agent, probe, listWith(probe, key.accountHome))
      })
    },
    stop() {
      lifetime.abort()
    }
  }
}
