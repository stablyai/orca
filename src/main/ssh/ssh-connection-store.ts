import type { Store } from '../persistence'
import type { SshTarget } from '../../shared/ssh-types'
import { RUNTIME_OWNED_SSH_TARGET_ID_PREFIX } from '../../shared/execution-host'
import { loadUserSshConfig, sshConfigHostsToTargets } from './ssh-config-parser'

export class SshConnectionStore {
  constructor(private store: Store) {}

  listTargets(): SshTarget[] {
    return this.store.getSshTargets().filter((target) => !isRuntimeOwnedSshTarget(target))
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
    return full
  }

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
    if (target && isConfigManagedTarget(target)) {
      const alias = target.configHost ?? target.label
      if (alias) {
        this.store.addDeletedSshConfigAlias(alias)
      }
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
   * manual targets. Returns the inserted and updated targets.
   */
  importFromSshConfig(options?: { reAdopt?: boolean }): SshTarget[] {
    // Why: the explicit Import action re-adopts every config host, so it clears
    // all tombstones first. The passive on-open sync passes no flag and keeps
    // deleted hosts suppressed.
    if (options?.reAdopt) {
      this.store.clearDeletedSshConfigAliases()
    }
    const deletedAliases = new Set(this.store.getDeletedSshConfigAliases())
    const configHosts = loadUserSshConfig()
    const existingTargets = this.store.getSshTargets()
    // Map config-managed targets (and legacy targets that strongly look like
    // prior imports) by their config alias so a repeat import reconciles instead
    // of duplicating. Manual targets are excluded — their alias stays reserved
    // and untouched.
    const syncableByAlias = new Map<string, SshTarget>()
    const manualAliases = new Set<string>()
    for (const existing of existingTargets) {
      const alias = existing.configHost ?? existing.label
      if (
        existing.source === 'manual' ||
        (existing.source === undefined && !isLegacyConfigImportTarget(existing))
      ) {
        manualAliases.add(alias)
        continue
      }
      if (alias && !syncableByAlias.has(alias)) {
        syncableByAlias.set(alias, existing)
      }
    }

    // Pass an empty exclusion set so the parser returns a candidate for every
    // config host (within-config de-duplication still applies); reconciliation
    // against existing targets happens here.
    const candidates = sshConfigHostsToTargets(configHosts, new Set())
    const changed: SshTarget[] = []
    // Guard against ever processing the same alias twice in one pass, so a
    // duplicate candidate can never produce a duplicate target — independent of
    // the parser's own within-config de-duplication.
    const processedAliases = new Set<string>()

    for (const candidate of candidates) {
      const alias = candidate.configHost ?? candidate.label
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
          proxyCommand: candidate.proxyCommand,
          jumpHost: candidate.jumpHost
        }
        // Skip the write (and the "synced" report) when nothing changed, so a
        // repeat sync on every pane open is a no-op. A legacy target with no
        // `source` is always rewritten once to stamp it as config-managed.
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
        const inserted: SshTarget = { ...candidate, source: 'ssh-config' }
        this.store.addSshTarget(inserted)
        changed.push(inserted)
      }
    }

    return changed
  }
}

export function getRuntimeOwnedSshTargetId(runtimeId: string): string {
  return `${RUNTIME_OWNED_SSH_TARGET_ID_PREFIX}${runtimeId}`
}

export function isRuntimeOwnedSshTarget(target: SshTarget): boolean {
  return target.owner?.type === 'on-demand-runtime'
}

function isConfigManagedTarget(target: SshTarget): boolean {
  // Why: a target is subject to config sync (and therefore needs a tombstone on
  // delete) when it is explicitly config-sourced, or a legacy import that sync
  // still adopts. Manual targets are excluded — sync never re-adds them.
  return (
    target.source === 'ssh-config' ||
    (target.source === undefined && isLegacyConfigImportTarget(target))
  )
}

function isLegacyConfigImportTarget(target: SshTarget): boolean {
  const alias = target.configHost ?? target.label
  // Why: legacy manual and imported targets both lack `source`. Only adopt the
  // old import shape, where the SSH alias was kept as label/configHost while
  // host stored the resolved HostName; otherwise preserve the user's target.
  return Boolean(
    alias && target.label === alias && target.configHost === alias && target.host !== alias
  )
}
