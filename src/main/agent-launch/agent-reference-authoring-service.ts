// Reference-side authoring authority (owner references over agent tombstones):
// snapshots, the reference mutation path, and the reference-driven tombstone GC.
// Split out of AgentCatalogService, which composes it and delegates.

import type { Store } from '../persistence'
import { buildUnreferencedTombstonePrunePatch } from './agent-catalog-tombstone-gc'
import { normalizeCatalogFromSettings } from './agent-catalog-projections'
import {
  buildAgentReferenceSnapshot,
  measureAgentReferenceProjection
} from './agent-reference-snapshot-projection'
import {
  agentCatalogMigrationBlockedError,
  agentCatalogSchemaTooNewError,
  type AgentCatalogMigrationBlockedError,
  type AgentCatalogSchemaTooNewError
} from './agent-catalog-write-policy'
import {
  commitAuthoringPatchDurable,
  type AgentReferenceWriteFailedError
} from './agent-catalog-durable-write'
import { applyAgentReferenceMutation } from './agent-reference-mutations'
import type {
  AgentReferenceMutationRequest,
  AgentReferenceMutationResult,
  AgentReferenceProjectionError,
  AgentReferenceSnapshot,
  LocalAgentReferenceSnapshot
} from '../../shared/agent-reference-snapshot'

const MAX_REFERENCE_PROJECTION_BYTES = 524_288

export type AgentReferenceAuthoringDeps = {
  store: Store
  countTombstoneReferences: Parameters<typeof buildUnreferencedTombstonePrunePatch>[2]
  catalogRevision: () => number
  publishCatalogRevision: (revision: number) => void
}

export class AgentReferenceAuthoringService {
  constructor(private readonly deps: AgentReferenceAuthoringDeps) {}

  private get store(): Store {
    return this.deps.store
  }

  getRevision(): number {
    return this.store.getSettings().agentReferenceRevision ?? 1
  }

  /** Remote (runtime RPC) reference snapshot; typed projection error when over
   *  the 512 KiB frame budget. */
  getRemoteSnapshot(): AgentReferenceSnapshot | AgentReferenceProjectionError {
    const settings = this.store.getSettings()
    const snapshot = buildAgentReferenceSnapshot(settings)
    const { tooLarge } = measureAgentReferenceProjection(settings)
    if (tooLarge) {
      return {
        version: 1,
        revision: snapshot.revision,
        code: 'agent_reference_payload_too_large',
        maxBytes: MAX_REFERENCE_PROJECTION_BYTES
      }
    }
    return snapshot
  }

  /** Uncapped authoring/repair view over local preload IPC only. */
  getLocalSnapshot(): LocalAgentReferenceSnapshot {
    const settings = this.store.getSettings()
    const snapshot = buildAgentReferenceSnapshot(settings)
    const { bytes, tooLarge } = measureAgentReferenceProjection(settings)
    return {
      ...snapshot,
      projection: tooLarge
        ? { status: 'too-large', bytes, maxBytes: MAX_REFERENCE_PROJECTION_BYTES }
        : { status: 'ready', bytes, maxBytes: MAX_REFERENCE_PROJECTION_BYTES }
    }
  }

  mutate(
    request: AgentReferenceMutationRequest
  ):
    | AgentReferenceMutationResult<LocalAgentReferenceSnapshot>
    | AgentCatalogMigrationBlockedError
    | AgentCatalogSchemaTooNewError
    | AgentReferenceWriteFailedError {
    // The failed-backup invariant is "no v1 write": reference mutations stamp
    // agentReferenceRevision, so they are blocked alongside catalog mutations.
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
    const currentReferenceRevision = settings.agentReferenceRevision ?? 1
    const application = applyAgentReferenceMutation({
      settings,
      request,
      currentReferenceRevision,
      catalog: normalizeCatalogFromSettings(settings)
    })
    if (!application.ok) {
      return {
        ok: false,
        code: application.code,
        referenceRevision: currentReferenceRevision,
        catalogRevision: this.deps.catalogRevision(),
        ...(application.code === 'reference_revision_conflict'
          ? { snapshot: this.getLocalSnapshot() }
          : {}),
        ...(application.owner ? { owner: application.owner } : {}),
        ...(application.field ? { field: application.field } : {}),
        ...(application.reason ? { reason: application.reason } : {})
      }
    }
    // The 512 KiB remote-projection budget is checked on the post-mutation
    // snapshot; a non-growing write still commits so an over-budget profile can
    // always be edited back under budget (mirrors mutate()'s security-reducing
    // allowlist). Why preview: persistence normalizes the patch and derives
    // legacy commitMessageAi from sourceControlAi, so the patch as written is
    // smaller than the projection that actually ships.
    const projected = measureAgentReferenceProjection(
      this.store.previewSettingsUpdate(application.patch)
    )
    if (projected.tooLarge && projected.bytes > measureAgentReferenceProjection(settings).bytes) {
      return {
        ok: false,
        code: 'agent_reference_payload_too_large',
        referenceRevision: currentReferenceRevision,
        catalogRevision: this.deps.catalogRevision()
      }
    }
    // Owner change commits before any prune; a failure between the two leaves
    // the tombstone conservatively retained for the next indexed recheck.
    if (!commitAuthoringPatchDurable(this.store, application.patch)) {
      return {
        ok: false,
        code: 'agent_reference_write_failed',
        referenceRevision: currentReferenceRevision,
        catalogRevision: this.deps.catalogRevision()
      }
    }
    this.pruneUnreferencedTombstones()
    return {
      ok: true,
      referenceRevision: application.newReferenceRevision,
      catalogRevision: this.deps.catalogRevision(),
      snapshot: this.getLocalSnapshot()
    }
  }

  /** Reference-aware prune run after a reference removal; a prune advances and
   *  publishes the catalog revision so receivers replace their snapshot. */
  private pruneUnreferencedTombstones(): void {
    const settings = this.store.getSettings()
    // The patch also strips any persisted row the pruned tombstone suppressed,
    // so the prune can never resurrect it.
    const prunePatch = buildUnreferencedTombstonePrunePatch(
      settings,
      normalizeCatalogFromSettings(settings),
      this.deps.countTombstoneReferences
    )
    if (!prunePatch) {
      return
    }
    const newRevision = (settings.agentCatalogRevision ?? 1) + 1
    // GC only: a rolled-back prune keeps the tombstone retained, and the next
    // indexed recheck retries it — the reference mutation is already durable.
    if (
      !commitAuthoringPatchDurable(this.store, { ...prunePatch, agentCatalogRevision: newRevision })
    ) {
      return
    }
    this.deps.publishCatalogRevision(newRevision)
  }
}
