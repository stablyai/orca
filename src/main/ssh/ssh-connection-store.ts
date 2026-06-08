import type { Store } from '../persistence'
import type { SshTarget } from '../../shared/ssh-types'
import { loadUserSshConfig, sshConfigHostsToTargets } from './ssh-config-parser'

export class SshConnectionStore {
  constructor(private store: Store) {}

  listTargets(): SshTarget[] {
    return this.store.getSshTargets()
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
    this.store.addSshTarget(full)
    return full
  }

  updateTarget(id: string, updates: Partial<Omit<SshTarget, 'id'>>): SshTarget | null {
    return this.store.updateSshTarget(id, updates)
  }

  removeTarget(id: string): void {
    this.store.removeSshTarget(id)
  }

  /**
   * Sync targets from ~/.ssh/config: insert new hosts, update existing
   * config-sourced ones in place (so a rotated port takes effect), never touch
   * manual targets. Returns the inserted and updated targets.
   */
  importFromSshConfig(): SshTarget[] {
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

function isLegacyConfigImportTarget(target: SshTarget): boolean {
  const alias = target.configHost ?? target.label
  // Why: legacy manual and imported targets both lack `source`. Only adopt the
  // old import shape, where the SSH alias was kept as label/configHost while
  // host stored the resolved HostName; otherwise preserve the user's target.
  return Boolean(
    alias && target.label === alias && target.configHost === alias && target.host !== alias
  )
}
