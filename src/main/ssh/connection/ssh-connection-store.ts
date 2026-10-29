import type { Store } from '../../persistence'
import type { SshRepoReadoption, SshTarget } from '../../../shared/ssh-types'
import { RUNTIME_OWNED_SSH_TARGET_ID_PREFIX } from '../../../shared/execution-host'
import { normalizeSshConfigAlias } from '../../../shared/ssh-config-alias'
import { isLegacyConfigImportTarget } from '../../../shared/ssh-target-source'
import { loadUserSshConfig, sshConfigHostsToTargets } from '../config/ssh-config-parser'
import { SshTargetOrcadClaims } from '../targets/ssh-target-orcad-claims'
import {
  buildRemovedSshTargetTombstone,
  readoptOrphanedWorkspacesForTarget
} from '../targets/ssh-target-readoption'

export class SshConnectionStore {
  constructor(private store: Store) {}

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

  /** Sync config-managed targets in place, including rotated ports; reserve manual aliases untouched. Return inserted/updated targets. */
  importFromSshConfig(options?: { reAdopt?: boolean }): SshTarget[] {
    const readoptions: SshRepoReadoption[] = []
    // Explicit Import clears tombstones; passive on-open sync preserves them.
    if (options?.reAdopt) {
      this.store.clearDeletedSshConfigAliases()
    }
    // Normalize aliases consistently with picker, duplicate checks and tombstones.
    const deletedAliases = new Set(
      this.store.getDeletedSshConfigAliases().map((alias) => normalizeSshConfigAlias(alias))
    )
    const configHosts = loadUserSshConfig()
    const existingTargets = this.store.getSshTargets()
    // Reconcile config/recognizable legacy imports by alias; manual aliases stay reserved.
    const syncableByAlias = new Map<string, SshTarget>()
    const manualAliases = new Set<string>()
    for (const existing of existingTargets) {
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

    // Let parsing deduplicate config internally; reconcile all candidates against existing targets here.
    const candidates = sshConfigHostsToTargets(configHosts, new Set())
    const changed: SshTarget[] = []
    // Guard duplicates independently of parser deduplication.
    const processedAliases = new Set<string>()

    for (const candidate of candidates) {
      const alias = normalizeSshConfigAlias(candidate.configHost ?? candidate.label)
      if (manualAliases.has(alias)) {
        // A manual target owns this alias — never clobber it.
        continue
      }
      if (deletedAliases.has(alias)) {
        // The user deleted this config host — stay deleted until they re-add it
        // or re-adopt config explicitly.
        continue
      }
      if (processedAliases.has(alias)) {
        continue
      }
      processedAliases.add(alias)
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

    this.lastRepoReadoptions = readoptions
    return changed
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
