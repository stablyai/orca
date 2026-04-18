import type { SshTarget, SshConnectionState } from '../../shared/ssh-types';
import { SshConnection, type SshConnectionCallbacks } from './ssh-connection';
export declare class SshConnectionManager {
    private connections;
    private callbacks;
    private connectingTargets;
    constructor(callbacks: SshConnectionCallbacks);
    connect(target: SshTarget): Promise<SshConnection>;
    disconnect(targetId: string): Promise<void>;
    getConnection(targetId: string): SshConnection | undefined;
    getState(targetId: string): SshConnectionState | null;
    getAllStates(): Map<string, SshConnectionState>;
    disconnectAll(): Promise<void>;
}
