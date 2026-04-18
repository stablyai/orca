import { type BrowserWindow } from 'electron';
import type { Store } from '../persistence';
import { SshConnectionStore } from '../ssh/ssh-connection-store';
import { SshConnectionManager } from '../ssh/ssh-connection';
import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer';
export declare function registerSshHandlers(store: Store, getMainWindow: () => BrowserWindow | null): {
    connectionManager: SshConnectionManager;
    sshStore: SshConnectionStore;
};
export declare function getSshConnectionManager(): SshConnectionManager | null;
export declare function getSshConnectionStore(): SshConnectionStore | null;
export declare function getActiveMultiplexer(connectionId: string): SshChannelMultiplexer | undefined;
