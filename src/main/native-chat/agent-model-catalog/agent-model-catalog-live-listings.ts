import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentModelCatalogLiveListing } from './agent-model-catalog-store'
import type {
  AgentModelCatalogServiceDeps,
  AgentModelCatalogSource
} from './agent-model-catalog-service-contract'
import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import { catalogFolder, recordConfiguredDefault } from './agent-model-catalog-workspace'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'

export function createAgentModelCatalogLiveListings(
  deps: AgentModelCatalogServiceDeps,
  signal: AbortSignal
) {
  const workspaces = new Map<string, { holders: number }>()
  const retireContext = (workspaceId?: string): void => {
    if (workspaceId === undefined) {
      workspaces.clear()
    } else {
      workspaces.delete(workspaceId)
    }
  }
  const leaseWorkspace = (id?: string) => {
    const epoch = id === undefined ? undefined : (workspaces.get(id) ?? { holders: 0 })
    if (epoch && id !== undefined) {
      epoch.holders += 1
      workspaces.set(id, epoch)
    }
    let released = false
    return {
      current: () =>
        !released && !signal.aborted && (id === undefined || workspaces.get(id) === epoch),
      release: () => {
        if (released) {
          return
        }
        released = true
        if (epoch && id !== undefined && --epoch.holders === 0 && workspaces.get(id) === epoch) {
          workspaces.delete(id)
        }
      }
    }
  }
  const recordIdentity = (record: AgentSessionRecord): string =>
    JSON.stringify([
      record.provider,
      record.accountHome,
      record.location,
      record.launchDirectory,
      deps.drivesRecord(record)
    ])
  const captureSource = (
    origin: Pick<AgentSessionRecord, 'provider' | 'location'>
  ): AgentModelCatalogSource => {
    const lease = leaseWorkspace(
      deps.listsInChatFolder?.has(origin.provider) ? origin.location.workspaceId : undefined
    )
    const revision = deps.store.retirementRevision(origin.provider)
    let bound: AgentSessionRecord | undefined =
      'sessionId' in origin ? deps.getRecord(String(origin.sessionId)) : undefined
    let identity = bound && recordIdentity(bound)
    return Object.assign(
      () =>
        lease.current() &&
        deps.store.retirementRevision(origin.provider) === revision &&
        (!bound || recordIdentity(deps.getRecord(bound.sessionId) ?? bound) === identity),
      {
        release: lease.release,
        bind: (record: AgentSessionRecord) => {
          if (!bound) {
            bound = record
            identity = recordIdentity(record)
          }
        }
      }
    )
  }
  // Default projections retain report order without delaying inventory observations.
  const recordingDefaults = new Map<string, Promise<void>>()
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
    fingerprint: string,
    current: () => boolean
  ): Promise<void> => {
    if (!current()) {
      return Promise.resolve()
    }
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
        .then(() =>
          recordConfiguredDefault(deps, record, fingerprint, configuredDefault, current, saved.live)
        )
        .catch(() => {})
        .then(() => {
          if (recordingDefaults.get(fingerprint) === recording) {
            recordingDefaults.delete(fingerprint)
          }
        })
      recordingDefaults.set(fingerprint, recording)
      return recording
    }
    return Promise.resolve()
  }
  return {
    captureSource,
    retireContext,
    providerStarted(record: AgentSessionRecord, source?: () => boolean) {
      const receipt = leaseWorkspace(record.location.workspaceId)
      const current = () =>
        receipt.current() &&
        source?.() !== false &&
        deps.getRecord(record.sessionId)?.lease.runtimeFence === record.lease.runtimeFence
      void sessionCatalogKey(record)
        .then((fingerprint) => {
          if (current()) {
            deps.store.expireFailure(fingerprint)
          }
        })
        .catch(() => {})
        .finally(receipt.release)
    },
    recordLiveListing(
      sessionId: string,
      listing: AgentModelCatalogLiveListing,
      source?: () => boolean
    ) {
      const record = deps.getRecord(sessionId)
      if (
        !record ||
        !deps.drivesRecord(record) ||
        record.provider === 'pi' ||
        independentAgentModelCatalog(record.provider)
      ) {
        return
      }
      const receipt = leaseWorkspace(record.location.workspaceId)
      const current = () =>
        receipt.current() &&
        source?.() !== false &&
        deps.getRecord(record.sessionId)?.lease.runtimeFence === record.lease.runtimeFence
      if (!current()) {
        receipt.release()
        return
      }
      if (!deps.listsInChatFolder?.has(record.provider)) {
        void saveLiveListing(
          record,
          listing,
          agentModelCatalogFingerprintForRecord(record),
          current
        ).finally(receipt.release)
        return
      }
      // In report order: a folder lookup that resolves late must not let an older listing land last.
      const writing = (liveWrites.get(sessionId) ?? Promise.resolve())
        .then(async () =>
          saveLiveListing(record, listing, await sessionCatalogKey(record), current)
        )
        .catch((error: unknown) => {
          console.warn('[agent-model-catalog] could not save a chat model list:', error)
        })
        .finally(() => {
          receipt.release()
          if (liveWrites.get(sessionId) === writing) {
            liveWrites.delete(sessionId)
          }
        })
      liveWrites.set(sessionId, writing)
    }
  }
}
