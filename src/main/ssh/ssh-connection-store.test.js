import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SshConnectionStore } from './ssh-connection-store';
const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
    loadUserSshConfigMock: vi.fn(),
    sshConfigHostsToTargetsMock: vi.fn()
}));
vi.mock('./ssh-config-parser', () => ({
    loadUserSshConfig: loadUserSshConfigMock,
    sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}));
function createMockStore() {
    const targets = [];
    return {
        getSshTargets: vi.fn(() => [...targets]),
        getSshTarget: vi.fn((id) => targets.find((t) => t.id === id)),
        addSshTarget: vi.fn((target) => targets.push(target)),
        updateSshTarget: vi.fn((id, updates) => {
            const target = targets.find((t) => t.id === id);
            if (!target) {
                return null;
            }
            Object.assign(target, updates);
            return { ...target };
        }),
        removeSshTarget: vi.fn((id) => {
            const idx = targets.findIndex((t) => t.id === id);
            if (idx !== -1) {
                targets.splice(idx, 1);
            }
        })
    };
}
describe('SshConnectionStore', () => {
    let mockStore;
    let sshStore;
    beforeEach(() => {
        mockStore = createMockStore();
        sshStore = new SshConnectionStore(mockStore);
        loadUserSshConfigMock.mockReset();
        sshConfigHostsToTargetsMock.mockReset();
    });
    it('listTargets delegates to store', () => {
        sshStore.listTargets();
        expect(mockStore.getSshTargets).toHaveBeenCalled();
    });
    it('getTarget delegates to store', () => {
        sshStore.getTarget('test-id');
        expect(mockStore.getSshTarget).toHaveBeenCalledWith('test-id');
    });
    it('addTarget generates an id and persists', () => {
        const target = sshStore.addTarget({
            label: 'My Server',
            host: 'example.com',
            port: 22,
            username: 'deploy'
        });
        expect(target.id).toMatch(/^ssh-/);
        expect(target.label).toBe('My Server');
        expect(mockStore.addSshTarget).toHaveBeenCalledWith(target);
    });
    it('updateTarget delegates to store', () => {
        const original = {
            id: 'ssh-1',
            label: 'Old Name',
            host: 'example.com',
            port: 22,
            username: 'user'
        };
        mockStore.addSshTarget(original);
        const result = sshStore.updateTarget('ssh-1', { label: 'New Name' });
        expect(result).toBeTruthy();
        expect(mockStore.updateSshTarget).toHaveBeenCalledWith('ssh-1', { label: 'New Name' });
    });
    it('removeTarget delegates to store', () => {
        sshStore.removeTarget('ssh-1');
        expect(mockStore.removeSshTarget).toHaveBeenCalledWith('ssh-1');
    });
    describe('importFromSshConfig', () => {
        it('imports new hosts from SSH config', () => {
            const configHosts = [{ host: 'staging', hostname: 'staging.example.com' }];
            const newTargets = [
                {
                    id: 'ssh-new-1',
                    label: 'staging',
                    host: 'staging.example.com',
                    port: 22,
                    username: ''
                }
            ];
            loadUserSshConfigMock.mockReturnValue(configHosts);
            sshConfigHostsToTargetsMock.mockReturnValue(newTargets);
            const result = sshStore.importFromSshConfig();
            expect(result).toEqual(newTargets);
            expect(mockStore.addSshTarget).toHaveBeenCalledWith(newTargets[0]);
        });
        it('passes existing target labels to avoid duplicates', () => {
            const existing = {
                id: 'ssh-existing',
                label: 'production',
                host: 'prod.example.com',
                port: 22,
                username: 'deploy'
            };
            mockStore.addSshTarget(existing);
            loadUserSshConfigMock.mockReturnValue([]);
            sshConfigHostsToTargetsMock.mockReturnValue([]);
            sshStore.importFromSshConfig();
            expect(sshConfigHostsToTargetsMock).toHaveBeenCalledWith([], new Set(['production']));
        });
        it('returns empty array when no new hosts found', () => {
            loadUserSshConfigMock.mockReturnValue([]);
            sshConfigHostsToTargetsMock.mockReturnValue([]);
            const result = sshStore.importFromSshConfig();
            expect(result).toEqual([]);
        });
    });
});
