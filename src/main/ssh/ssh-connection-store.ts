import type { Store } from '../persistence'
import type { SshRepoReadoption, SshTarget } from '../../shared/ssh-types'
import { RUNTIME_OWNED_SSH_TARGET_ID_PREFIX } from '../../shared/execution-host'
import { loadUserSshConfig, sshConfigHostsToTargets } from './ssh-config-parser'
import {
  buildRemovedSshTargetTombstone,
  readoptOrphanedWorkspacesForTarget
} from './ssh-target-readoption'
import {
  getSshTargetSourceKey,
  isSshTargetManagedBySource,
  reconcileSshTargetsFromSource
} from './ssh-target-source-reconciliation'

export class SshConnectionStore {
  constructor(private store: Store) {}

  listTargets(): SshTarget[] {
    return this.store.getSshTargets().filter((target) => !isRuntimeOwnedSshTarget(target))
  }

  /** Map of removed-target id → its last known label, from the re-adoption
   *  tombstones. Lets the renderer show a friendly host name for a workspace
   *  still pinned to a target that no longer exists. */
  listRemovedTargetLabels(): Record<string, string> {
    const labels: Record<string, string> = {}
    for (const tombstone of this.store.getRemovedSshTargetTombstones()) {
      labels[tombstone.oldTargetId] = tombstone.label
    }
    return labels
  }

  getTarget(id: string): SshTarget | undefined {
    return this.store.getSshTarget(id)
  }

  addTarget(target: Omit<SshTarget, 'id'>): SshTarget {
    const full: SshTarget = {
      ...target,
      configHost: target.configHost ?? target.host,
      // Why: default to 'manual' so user-created targets are never overwritten
      // by a later ~/.ssh/config import (only 'ssh-config' targets are synced).
      source: target.source ?? 'manual',
      id: `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    }
    // Why: re-adding a host the user previously deleted is an explicit intent to
    // keep it — lift any tombstone so config sync stops suppressing this alias.
    this.reclaimAlias(full.configHost ?? full.label)
    this.store.addSshTarget(full)
    // Why: re-adopt workspaces that were orphaned when the same host was removed
    // (repos/worktrees still point at the old, now-dead target id). Track the
    // exact migrations so IPC can refresh and renderer can prune only proven stale rows.
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

  updateTarget(id: string, updates: Partial<Omit<SshTarget, 'id'>>): SshTarget | null {
    const updated = this.store.updateSshTarget(id, updates)
    if (updated) {
      // Why: actively editing a target reclaims its alias from the deleted set,
      // so an edit can never leave the host tombstoned.
      this.reclaimAlias(updated.configHost ?? updated.label)
    }
    return updated
  }

  removeTarget(id: string): void {
    const target = this.store.getSshTarget(id)
    // Why: deleting a config-managed target must record a tombstone; otherwise
    // the next ~/.ssh/config sync re-inserts it verbatim (the config entry still
    // exists on disk) and the host reappears. Manual targets need no tombstone —
    // sync never re-adds them.
    if (
      target &&
      isSshTargetManagedBySource(
        target,
        { kind: 'ssh-config' },
        {
          adoptLegacySshConfigTargets: true
        }
      )
    ) {
      const alias = getSshTargetSourceKey(target)
      if (alias) {
        this.store.addDeletedSshConfigAlias(alias)
      }
    }
    // Why: record the removed target's host identity (for ALL user-facing
    // targets, config-managed or manual) so a later re-add of the same host can
    // re-adopt any workspaces orphaned on this id. Runtime-owned targets manage
    // their own lifecycle and are never re-adopted.
    if (target && !isRuntimeOwnedSshTarget(target)) {
      this.store.addRemovedSshTargetTombstone(buildRemovedSshTargetTombstone(target, Date.now()))
    }
    this.store.removeSshTarget(id)
  }

  private reclaimAlias(alias: string | undefined): void {
    if (alias) {
      this.store.removeDeletedSshConfigAlias(alias)
    }
  }

  /**
   * Sync targets from ~/.ssh/config: insert new hosts, update existing
   * config-sourced ones in place (so a rotated port takes effect), never touch
   * targets owned by another source. Returns the inserted and updated targets.
   */
  importFromSshConfig(options?: { reAdopt?: boolean }): SshTarget[] {
    const readoptions: SshRepoReadoption[] = []
    // Why: the explicit Import action re-adopts every config host, so it clears
    // all tombstones first. The passive on-open sync passes no flag and keeps
    // deleted hosts suppressed.
    if (options?.reAdopt) {
      this.store.clearDeletedSshConfigAliases()
    }
    const configHosts = loadUserSshConfig()
    // Pass an empty exclusion set so the parser returns a candidate for every
    // config host (within-config de-duplication still applies); reconciliation
    // against existing targets happens here.
    const candidates = sshConfigHostsToTargets(configHosts, new Set())
    const changes = reconcileSshTargetsFromSource({
      source: { kind: 'ssh-config' },
      existingTargets: this.store.getSshTargets(),
      candidates,
      deletedTargetKeys: new Set(this.store.getDeletedSshConfigAliases()),
      adoptLegacySshConfigTargets: true
    })
    const changed: SshTarget[] = []
    for (const change of changes) {
      if (change.kind === 'update') {
        const updated = this.store.updateSshTarget(change.id, change.updates)
        if (updated) {
          changed.push(updated)
        }
      } else {
        const inserted = change.target
        this.store.addSshTarget(inserted)
        // Why: a freshly-inserted config host may be one the user removed and is
        // now re-importing — re-adopt its orphaned workspaces. Updated-in-place
        // targets keep their id, so their repos were never orphaned.
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

export function isRuntimeOwnedSshTarget(target: SshTarget): boolean {
  return target.owner?.type === 'on-demand-runtime'
}
