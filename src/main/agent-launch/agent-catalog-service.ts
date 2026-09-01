// Main-owned agent-catalog service: the single authoring authority. Desktop
// Settings mutate through it (never by writing whole settings arrays), it owns
// repair tokens and the tombstone reference index, and it enforces the local
// (16 MiB) and remote-projection (512 KiB) payload budgets before any write.

import type { Store } from '../persistence'
import type { BuiltInTuiAgent, CustomTuiAgentId } from '../../shared/types'
import type {
  AgentCatalogMutationRequest,
  AgentCatalogMutationResult,
  LocalAgentCatalogSnapshot,
  LocalCustomAgentDraftResult
} from '../../shared/agent-catalog-snapshot'
import { MAX_LOCAL_AGENT_DRAFT_BYTES } from '../../shared/agent-catalog-snapshot'
import { utf8ByteLength } from '../../shared/custom-tui-agents'
import {
  AgentCatalogRepairTokenRegistry,
  applyAgentCatalogMutation
} from './agent-catalog-mutations'
import {
  buildAgentCatalogSnapshot,
  buildLocalAgentCatalogSnapshot,
  measureAgentCatalogProjection,
  measureLocalAgentCatalogStorage,
  normalizeCatalogFromSettings
} from './agent-catalog-projections'
import {
  AgentTombstoneReferenceIndex,
  type AgentReferenceSummary
} from './agent-tombstone-reference-index'
import {
  createBatchTombstoneReferenceCounter,
  registerBuiltInOwnerScanners
} from './agent-catalog-owner-scanners'
import {
  agentCatalogMigrationBlockedError,
  agentCatalogSchemaTooNewError,
  isSecurityReducingMutation,
  type AgentCatalogMigrationBlockedError,
  type AgentCatalogSchemaTooNewError
} from './agent-catalog-write-policy'
import { computeBaseDisableImpact } from './agent-catalog-base-disable-impact'
import {
  commitAuthoringPatchDurable,
  type AgentCatalogWriteFailedError,
  type AgentReferenceWriteFailedError
} from './agent-catalog-durable-write'
import { AgentReferenceAuthoringService } from './agent-reference-authoring-service'
import type {
  AgentReferenceMutationRequest,
  AgentReferenceMutationResult,
  AgentReferenceProjectionError,
  AgentReferenceSnapshot,
  BaseDisableImpact,
  LocalAgentReferenceSnapshot
} from '../../shared/agent-reference-snapshot'

let serviceInstance: AgentCatalogService | null = null
let serviceStore: Store | null = null

/** One service per Store instance (profile switching replaces the Store). Both
 *  local IPC and the runtime RPC layer must share this instance so repair
 *  tokens and reference scanners agree. */
export function getOrCreateAgentCatalogService(store: Store): AgentCatalogService {
  if (!serviceInstance || serviceStore !== store) {
    serviceInstance = new AgentCatalogService(store)
    serviceStore = store
  }
  return serviceInstance
}

export class AgentCatalogService {
  private readonly repairTokens = new AgentCatalogRepairTokenRegistry()
  private readonly referenceIndex = new AgentTombstoneReferenceIndex()
  // Reads the index live, so scanners registered after construction still count.
  private readonly tombstoneReferenceCounter = createBatchTombstoneReferenceCounter(
    this.referenceIndex
  )
  private readonly changeListeners = new Set<(revision: number) => void>()
  private readonly references: AgentReferenceAuthoringService

  constructor(private readonly store: Store) {
    registerBuiltInOwnerScanners(this.referenceIndex, this.store)
    this.references = new AgentReferenceAuthoringService({
      store,
      countTombstoneReferences: this.tombstoneReferenceCounter,
      catalogRevision: () => this.getRevision(),
      publishCatalogRevision: (revision) => {
        for (const listener of this.changeListeners) {
          listener(revision)
        }
      }
    })
  }

  /** Later units (worktree pending launches, background attempts, orchestration,
   *  sleeping sessions) register their owner scanners through this. */
  get tombstoneReferenceIndex(): AgentTombstoneReferenceIndex {
    return this.referenceIndex
  }

  onDidChange(listener: (revision: number) => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  getRevision(): number {
    return this.store.getSettings().agentCatalogRevision ?? 1
  }

  getLocalSnapshot(): LocalAgentCatalogSnapshot {
    const base = buildLocalAgentCatalogSnapshot(this.store.getSettings(), this.repairTokens)
    const blocked = agentCatalogMigrationBlockedError(this.store)
    const snapshot = blocked ? { ...base, migrationBlockedError: blocked.migrationError } : base
    const tooNew = agentCatalogSchemaTooNewError(this.store)
    if (!tooNew) {
      return snapshot
    }
    return {
      ...snapshot,
      schemaTooNew: {
        persistedVersion: tooNew.persistedVersion,
        supportedVersion: tooNew.supportedVersion
      }
    }
  }

  getRemoteSnapshot(): ReturnType<typeof buildAgentCatalogSnapshot> {
    const snapshot = buildAgentCatalogSnapshot(this.store.getSettings())
    // Boolean-only block flag (the error text never crosses the wire); a
    // projection error never carries it — a blocked host is pre-v1, never oversize.
    if (!('customAgents' in snapshot) || !agentCatalogMigrationBlockedError(this.store)) {
      return snapshot
    }
    return { ...snapshot, migrationBlocked: true }
  }

  /** Local-desktop-only reference summary for delete confirmation and "Review
   *  references"; owner kind + count only, no prompt/config/env. */
  getReferenceSummaries(id: CustomTuiAgentId): AgentReferenceSummary[] {
    return this.referenceIndex.summarizeReferences(id)
  }

  getBaseDisableImpact(base: BuiltInTuiAgent): BaseDisableImpact {
    return computeBaseDisableImpact(this.store.getSettings(), this.referenceIndex, base)
  }

  /** Single-record full-env editor read, access-checked by the preload boundary
   *  and capped at 1 MiB. Never registered as a runtime RPC. */
  getLocalDraft(
    locator: { id: CustomTuiAgentId } | { repairToken: string },
    expectedRevision: number
  ): LocalCustomAgentDraftResult | { status: 'stale' } {
    const settings = this.store.getSettings()
    const revision = settings.agentCatalogRevision ?? 1
    if (expectedRevision !== revision) {
      return { status: 'stale' }
    }
    const catalog = normalizeCatalogFromSettings(settings)
    const raw: unknown =
      'id' in locator
        ? (catalog.liveById.get(locator.id) ??
          catalog.repairRequiredById.get(locator.id)?.raw ??
          null)
        : this.repairTokens.resolve(locator.repairToken, [
            ...catalog.corruptRows,
            ...catalog.repairRequiredById.values()
          ])?.raw
    if (raw === null || raw === undefined) {
      return { status: 'stale' }
    }
    const bytes = utf8ByteLength(JSON.stringify(raw) ?? 'null')
    if (bytes > MAX_LOCAL_AGENT_DRAFT_BYTES) {
      return { status: 'too-large', revision, bytes, maxBytes: MAX_LOCAL_AGENT_DRAFT_BYTES }
    }
    const record = raw as Record<string, unknown>
    return {
      status: 'ready',
      revision,
      draft: {
        label: typeof record.label === 'string' ? record.label : '',
        commandOverride: typeof record.commandOverride === 'string' ? record.commandOverride : null,
        args: typeof record.args === 'string' ? record.args : '',
        env:
          record.env && typeof record.env === 'object' && !Array.isArray(record.env)
            ? ({ ...(record.env as Record<string, string>) } as Record<string, string>)
            : {},
        syncEnv: record.syncEnv === true
      }
    }
  }

  getReferenceRevision(): number {
    return this.references.getRevision()
  }

  getRemoteReferenceSnapshot(): AgentReferenceSnapshot | AgentReferenceProjectionError {
    return this.references.getRemoteSnapshot()
  }

  getLocalReferenceSnapshot(): LocalAgentReferenceSnapshot {
    return this.references.getLocalSnapshot()
  }

  mutateReferences(
    request: AgentReferenceMutationRequest
  ):
    | AgentReferenceMutationResult<LocalAgentReferenceSnapshot>
    | AgentCatalogMigrationBlockedError
    | AgentCatalogSchemaTooNewError
    | AgentReferenceWriteFailedError {
    return this.references.mutate(request)
  }

  mutate(
    request: AgentCatalogMutationRequest
  ):
    | AgentCatalogMutationResult
    | AgentCatalogMigrationBlockedError
    | AgentCatalogSchemaTooNewError
    | AgentCatalogWriteFailedError {
    // A failed pinned pre-v1 backup means no v1 write may land on the profile;
    // fail closed here so authoring cannot bypass the migration invariant.
    const blocked = agentCatalogMigrationBlockedError(this.store)
    if (blocked) {
      return blocked
    }
    // Persistence refuses the write anyway; reporting it up front keeps a
    // non-retryable read-only profile from looking like a disk failure.
    const tooNew = agentCatalogSchemaTooNewError(this.store)
    if (tooNew) {
      return tooNew
    }
    const settings = this.store.getSettings()
    const currentRevision = settings.agentCatalogRevision ?? 1
    const application = applyAgentCatalogMutation({
      settings,
      request,
      currentRevision,
      repairTokens: this.repairTokens,
      countTombstoneReferences: this.tombstoneReferenceCounter
    })
    if (!application.ok) {
      return {
        ok: false,
        code: application.code,
        revision: currentRevision,
        ...(application.code === 'catalog_revision_conflict'
          ? { snapshot: this.getLocalSnapshot() }
          : {}),
        ...(application.field ? { field: application.field } : {}),
        ...(application.reason ? { reason: application.reason } : {}),
        ...(application.envEntryIndex !== undefined
          ? { envEntryIndex: application.envEntryIndex }
          : {})
      }
    }

    // Payload budgets are checked on the post-mutation state as persistence will
    // normalize it (not the raw patch); while a budget is exceeded only the
    // security-reducing allowlist may still commit.
    const nextSettings = this.store.previewSettingsUpdate(application.patch)
    const localStorageStatus = measureLocalAgentCatalogStorage(nextSettings)
    const projectionStatus = measureAgentCatalogProjection(nextSettings)
    if (localStorageStatus.status === 'too-large' && !isSecurityReducingMutation(request)) {
      return { ok: false, code: 'agent_catalog_local_payload_too_large', revision: currentRevision }
    }
    if (projectionStatus.status === 'too-large' && !isSecurityReducingMutation(request)) {
      return { ok: false, code: 'agent_catalog_payload_too_large', revision: currentRevision }
    }

    // Durable before the ack: a lost create/delete would otherwise be reported as saved.
    if (!commitAuthoringPatchDurable(this.store, application.patch)) {
      return { ok: false, code: 'agent_catalog_write_failed', revision: currentRevision }
    }
    for (const listener of this.changeListeners) {
      listener(application.newRevision)
    }
    return { ok: true, revision: application.newRevision, snapshot: this.getLocalSnapshot() }
  }
}
