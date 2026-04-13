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
   * Import hosts from ~/.ssh/config that don't already exist as targets.
   * Returns the newly imported targets.
   */
  importFromSshConfig(): SshTarget[] {
    const existingLabels = new Set(this.store.getSshTargets().map((t) => t.label))
    const configHosts = loadUserSshConfig()
    const newTargets = sshConfigHostsToTargets(configHosts, existingLabels)

    for (const target of newTargets) {
      this.store.addSshTarget(target)
    }

    return newTargets
  }
}
