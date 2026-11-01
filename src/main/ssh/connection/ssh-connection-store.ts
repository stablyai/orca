import type { Store } from '../../persistence'
import type { SshRepoReadoption, SshTarget } from '../../../shared/ssh-types'
import { RUNTIME_OWNED_SSH_TARGET_ID_PREFIX } from '../../../shared/execution-host'
import { normalizeSshConfigAlias } from '../../../shared/ssh-config-alias'
import { isLegacyConfigImportTarget } from '../../../shared/ssh-target-source'
import {
  loadUserSshConfigWithText,
  sshConfigHostsToTargets,
  type SshConfigHost
} from '../config/ssh-config-parser'
import {
  findSshRouteDuplicates,
  sshRouteSnapshotFingerprint,
  type SshRouteResolvers,
  type SshRouteSnapshot
} from '../targets/ssh-target-route-resolution'
import { SshTargetOrcadClaims } from '../targets/ssh-target-orcad-claims'
import {
  buildRemovedSshTargetTombstone,
  readoptOrphanedWorkspacesForTarget
} from '../targets/ssh-target-readoption'

// Reuse a snapshot while nothing it was built from changed, but re-resolve now and then: /etc/ssh_config and Match exec can change too.
const ROUTE_SNAPSHOT_TTL_MS = 5 * 60_000

export class SshConnectionStore {
  // Imports and picker refreshes run one at a time, each against one snapshot, so none can race another.
  private routeQueue: Promise<unknown> = Promise.resolve()
  private latestRouteSnapshot: SshRouteSnapshot | null = null

  constructor(
    private store: Store,
    private routeResolvers?: SshRouteResolvers
  ) {}

  listTargets(): SshTarget[] {
    return this.store.getSshTargets().filter((target) => !isRuntimeOwnedSshTarget(target))
  }

  /** Retain removed-target labels so pinned orphan workspaces can still show friendly host names. */
  listRemovedTargetLabels(): Record<string, string> {
    const labels: Record<string, string> = {}
    for (const tombstone of this.store.getRemovedSshTargetTombstones()) {
      labels[tombstone.oldTargetId] = tombstone.label
    }
    return labels
  }

  listSuppressedSshConfigAliases(): string[] {
    return this.store.getDeletedSshConfigAliases()
  }

  getTarget(id: string): SshTarget | undefined {
    return this.store.getSshTarget(id)
  }

  addTarget(target: Omit<SshTarget, 'id'>): SshTarget {
    const full: SshTarget = {
      ...target,
      configHost: target.configHost ?? target.host,
      // Manual targets must survive later config sync unchanged.
      source: target.source ?? 'manual',
      id: `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      // New registration generations must invalidate earlier automation fences.
      generation: this.store.allocateSshTargetGeneration()
    }
    // Explicit re-add reclaims the alias from passive-sync tombstones.
    this.reclaimAlias(full.configHost ?? full.label)
    this.store.addSshTarget(full)
    // Readopt orphaned workspaces with exact migrations so clients prune only proven stale rows.
    this.lastRepoReadoptions = readoptOrphanedWorkspacesForTarget(this.store, full)
    return full
  }

  /** Exact migrations from the most recent add/import operation. */
  lastRepoReadoptions: SshRepoReadoption[] = []

  upsertRuntimeOwnedTarget(
    runtimeId: string,
    target: Omit<SshTarget, 'id' | 'owner' | 'source' | 'lastRequiredPassphrase'>
  ): SshTarget {
    const id = getRuntimeOwnedSshTargetId(runtimeId)
    const existing = this.store.getSshTarget(id)
    const next: SshTarget = {
      ...target,
      id,
      configHost: target.configHost ?? target.host,
      owner: { type: 'on-demand-runtime', runtimeId },
      source: 'manual',
      // Preserve generation when updating a live registration.
      generation: existing?.generation ?? this.store.allocateSshTargetGeneration(),
      ...(existing?.lastRequiredPassphrase !== undefined
        ? { lastRequiredPassphrase: existing.lastRequiredPassphrase }
        : {})
    }
    if (existing) {
      return this.store.updateSshTarget(id, next) ?? next
    }
    this.store.addSshTarget(next)
    return next
  }

  /** Exclusive managed-orcad ownership of a target; see ssh-target-orcad-claims. */
  getOrcadRuntimeClaims(): SshTargetOrcadClaims {
    return new SshTargetOrcadClaims(this.store)
  }

  /** The profile reads and scrollback reservations a migration exports from. */
  getOrcadMigrationSource(): Store {
    return this.store
  }

  updateTarget(id: string, updates: Partial<Omit<SshTarget, 'id'>>): SshTarget | null {
    const existing = this.store.getSshTarget(id)
    // Endpoint/runtime edits must restart selection, not replay an old ladder rung.
    const changed = (key: 'remoteRuntime' | 'host' | 'port' | 'configHost'): boolean =>
      key in updates && existing?.[key] !== updates[key]
    const resetsRuntime =
      changed('remoteRuntime') || changed('host') || changed('port') || changed('configHost')
    const updated = this.store.updateSshTarget(
      id,
      resetsRuntime ? { ...updates, remoteRuntimeResolution: undefined } : updates
    )
    if (updated) {
      // Explicit edits also reclaim tombstoned aliases.
      this.reclaimAlias(updated.configHost ?? updated.label)
    }
    return updated
  }

  removeTarget(id: string): void {
    const target = this.store.getSshTarget(id)
    if (target && !isRuntimeOwnedSshTarget(target)) {
      const alias = target.configHost ?? target.label
      if (alias) {
        // Suppress passive resurrection while keeping the alias available for explicit picker re-add.
        this.store.addDeletedSshConfigAlias(alias)
      }
      this.store.addRemovedSshTargetTombstone(buildRemovedSshTargetTombstone(target, Date.now()))
    }
    this.store.removeSshTarget(id)
  }

  private reclaimAlias(alias: string | undefined): void {
    const normalized = normalizeSshConfigAlias(alias)
    if (!normalized) {
      return
    }
    // Lift all case variants, including tombstones saved before normalization.
    for (const stored of this.store.getDeletedSshConfigAliases()) {
      if (normalizeSshConfigAlias(stored) === normalized) {
        this.store.removeDeletedSshConfigAlias(stored)
      }
    }
  }

  /**
   * Sync config-managed targets in place, including rotated ports; reserve manual aliases untouched.
   * Skips a new alias whose resolved route an existing target already has. Returns its own readoptions.
   */
  importFromSshConfig(options?: {
    reAdopt?: boolean
  }): Promise<{ targets: SshTarget[]; repoReadoptions: SshRepoReadoption[] }> {
    return this.enqueueRouteRun(async () => {
      // Explicit Import clears tombstones; passive on-open sync preserves them.
      const restoredAliases = new Set<string>()
      if (options?.reAdopt) {
        for (const alias of this.store.getDeletedSshConfigAliases()) {
          restoredAliases.add(normalizeSshConfigAlias(alias))
        }
        this.store.clearDeletedSshConfigAliases()
      }
      const snapshot = await this.buildSshRouteSnapshot()
      const routeDuplicates = new Set(snapshot.duplicateOf.keys())
      // Restore asked for these hosts by name, so it brings them back even when another target shares the route.
      for (const alias of restoredAliases) {
        routeDuplicates.delete(alias)
      }
      const result = this.reconcileSshConfig(snapshot.configHosts, routeDuplicates)
      if (result.targets.length > 0) {
        // Its own changes outdate the snapshot; rebuild next so the picker keeps the flags it just acted on.
        void this.refreshSshRouteSnapshot().catch(() => {})
      }
      return result
    })
  }

  /** The latest route snapshot if nothing it was built from changed; the picker reads this without waiting. */
  currentSshRouteSnapshot(): SshRouteSnapshot | null {
    const snapshot = this.latestRouteSnapshot
    return snapshot &&
      Date.now() - snapshot.builtAt < ROUTE_SNAPSHOT_TTL_MS &&
      snapshot.fingerprint === this.routeSnapshotFingerprint(loadUserSshConfigWithText().text)
      ? snapshot
      : null
  }

  /** Builds a fresh snapshot through the same queue imports use. */
  refreshSshRouteSnapshot(): Promise<SshRouteSnapshot> {
    return this.enqueueRouteRun(() => this.buildSshRouteSnapshot())
  }

  private enqueueRouteRun<T>(run: () => Promise<T>): Promise<T> {
    const result = this.routeQueue.then(run, run)
    this.routeQueue = result.catch(() => {})
    return result
  }

  private routeSnapshotFingerprint(configText: string): string {
    return sshRouteSnapshotFingerprint({
      configText,
      targets: this.listTargets(),
      deletedAliases: this.store.getDeletedSshConfigAliases()
    })
  }

  private async buildSshRouteSnapshot(): Promise<SshRouteSnapshot> {
    const config = loadUserSshConfigWithText()
    const fingerprint = this.routeSnapshotFingerprint(config.text)
    const latest = this.latestRouteSnapshot
    if (
      latest?.fingerprint === fingerprint &&
      Date.now() - latest.builtAt < ROUTE_SNAPSHOT_TTL_MS
    ) {
      return latest
    }
    const plan = this.planSshConfigImport(config.hosts)
    const inserts = plan.candidates.filter(({ alias }) => !plan.syncableByAlias.has(alias))
    const duplicateOf = await findSshRouteDuplicates(
      inserts,
      this.listTargets(),
      this.routeResolvers
    )
    this.latestRouteSnapshot = {
      fingerprint,
      configHosts: config.hosts,
      duplicateOf,
      builtAt: Date.now()
    }
    return this.latestRouteSnapshot
  }

  // Which config candidates an import considers, and which existing config targets they update.
  private planSshConfigImport(configHosts: SshConfigHost[]): {
    candidates: { alias: string; candidate: SshTarget }[]
    syncableByAlias: Map<string, SshTarget>
  } {
    // Normalize aliases consistently with picker, duplicate checks and tombstones.
    const deletedAliases = new Set(
      this.store.getDeletedSshConfigAliases().map((alias) => normalizeSshConfigAlias(alias))
    )
    // Reconcile config/recognizable legacy imports by alias; manual aliases stay reserved.
    const syncableByAlias = new Map<string, SshTarget>()
    const manualAliases = new Set<string>()
    for (const existing of this.store.getSshTargets()) {
      const alias = normalizeSshConfigAlias(existing.configHost ?? existing.label)
      if (
        existing.source === 'manual' ||
        isRuntimeOwnedSshTarget(existing) ||
        isManagedOrcadSshTarget(existing) ||
        (existing.source === undefined && !isLegacyConfigImportTarget(existing))
      ) {
        manualAliases.add(alias)
        continue
      }
      if (alias && !syncableByAlias.has(alias)) {
        syncableByAlias.set(alias, existing)
      }
    }
    const candidates: { alias: string; candidate: SshTarget }[] = []
    // Guard duplicates independently of parser deduplication.
    const processedAliases = new Set<string>()
    // Let parsing deduplicate config internally; reconcile all candidates against existing targets here.
    for (const candidate of sshConfigHostsToTargets(configHosts, new Set())) {
      const alias = normalizeSshConfigAlias(candidate.configHost ?? candidate.label)
      // A manual target owns its alias, and a deleted config host stays deleted until re-added or re-adopted.
      if (manualAliases.has(alias) || deletedAliases.has(alias) || processedAliases.has(alias)) {
        continue
      }
      processedAliases.add(alias)
      candidates.push({ alias, candidate })
    }
    return { candidates, syncableByAlias }
  }

  private reconcileSshConfig(
    configHosts: SshConfigHost[],
    routeDuplicates: ReadonlySet<string>
  ): { targets: SshTarget[]; repoReadoptions: SshRepoReadoption[] } {
    const readoptions: SshRepoReadoption[] = []
    const { candidates, syncableByAlias } = this.planSshConfigImport(configHosts)
    const changed: SshTarget[] = []

    for (const { alias, candidate } of candidates) {
      const existing = syncableByAlias.get(alias)
      if (existing) {
        const nextFields = {
          configHost: candidate.configHost,
          host: candidate.host,
          port: candidate.port,
          username: candidate.username,
          identityFile: candidate.identityFile,
          identityAgent: candidate.identityAgent,
          identitiesOnly: candidate.identitiesOnly,
          gssapiAuthentication: candidate.gssapiAuthentication,
          proxyCommand: candidate.proxyCommand,
          jumpHost: candidate.jumpHost
        }
        // Skip unchanged writes/reports; stamp legacy imports as config-managed once.
        const isDirty =
          existing.source !== 'ssh-config' ||
          (Object.keys(nextFields) as (keyof typeof nextFields)[]).some(
            (key) => existing[key] !== nextFields[key]
          )
        if (!isDirty) {
          continue
        }
        const updated = this.store.updateSshTarget(existing.id, {
          ...nextFields,
          source: 'ssh-config'
        })
        if (updated) {
          changed.push(updated)
        }
      } else if (routeDuplicates.has(alias)) {
        // Another name for a machine already in Orca; inserting it would show its sessions twice.
        continue
      } else {
        const inserted: SshTarget = {
          ...candidate,
          source: 'ssh-config',
          generation: this.store.allocateSshTargetGeneration()
        }
        this.store.addSshTarget(inserted)
        // New ids may reclaim orphaned workspaces; in-place updates retain their repo links.
        readoptions.push(...readoptOrphanedWorkspacesForTarget(this.store, inserted))
        changed.push(inserted)
      }
    }

    return { targets: changed, repoReadoptions: readoptions }
  }
}

export function getRuntimeOwnedSshTargetId(runtimeId: string): string {
  return `${RUNTIME_OWNED_SSH_TARGET_ID_PREFIX}${runtimeId}`
}

/** Any target Orca created as an implementation detail; hidden from SSH-host surfaces. */
export function isRuntimeOwnedSshTarget(target: SshTarget): boolean {
  return target.owner !== undefined
}

/** A host serving (or being set up for) a managed Orca server: visible, but never a direct relay. */
export function isManagedOrcadSshTarget(target: SshTarget): boolean {
  return target.orcadFence !== undefined || target.orcadProvisioning !== undefined
}

/** Managed hosts cannot serve direct relays unless older retained projects still require their previous relay. */
export function allowsDirectSshRelay(target: SshTarget): boolean {
  if (target.orcadProvisioning) {
    return false
  }
  return !target.orcadFence || target.orcadFence.sourceChangedAt !== undefined
}
