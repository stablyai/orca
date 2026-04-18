import { loadUserSshConfig, sshConfigHostsToTargets } from './ssh-config-parser';
export class SshConnectionStore {
    store;
    constructor(store) {
        this.store = store;
    }
    listTargets() {
        return this.store.getSshTargets();
    }
    getTarget(id) {
        return this.store.getSshTarget(id);
    }
    addTarget(target) {
        const full = {
            ...target,
            configHost: target.configHost ?? target.host,
            id: `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        };
        this.store.addSshTarget(full);
        return full;
    }
    updateTarget(id, updates) {
        return this.store.updateSshTarget(id, updates);
    }
    removeTarget(id) {
        this.store.removeSshTarget(id);
    }
    /**
     * Import hosts from ~/.ssh/config that don't already exist as targets.
     * Returns the newly imported targets.
     */
    importFromSshConfig() {
        const existingLabels = new Set(this.store.getSshTargets().map((t) => t.configHost ?? t.label));
        const configHosts = loadUserSshConfig();
        const newTargets = sshConfigHostsToTargets(configHosts, existingLabels);
        for (const target of newTargets) {
            this.store.addSshTarget(target);
        }
        return newTargets;
    }
}
