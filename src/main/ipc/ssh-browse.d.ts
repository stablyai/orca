import type { SshConnectionManager } from '../ssh/ssh-connection';
export type RemoteDirEntry = {
    name: string;
    isDirectory: boolean;
};
export declare function registerSshBrowseHandler(getConnectionManager: () => SshConnectionManager | null): void;
