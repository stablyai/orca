import type { Store } from '../persistence';
import type { SshTarget } from '../../shared/ssh-types';
export declare class SshConnectionStore {
    private store;
    constructor(store: Store);
    listTargets(): SshTarget[];
    getTarget(id: string): SshTarget | undefined;
    addTarget(target: Omit<SshTarget, 'id'>): SshTarget;
    updateTarget(id: string, updates: Partial<Omit<SshTarget, 'id'>>): SshTarget | null;
    removeTarget(id: string): void;
    /**
     * Import hosts from ~/.ssh/config that don't already exist as targets.
     * Returns the newly imported targets.
     */
    importFromSshConfig(): SshTarget[];
}
