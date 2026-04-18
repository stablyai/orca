import { type BrowserWindow } from 'electron';
import type { SshCredentialKind } from '../ssh/ssh-connection-utils';
export declare function requestCredential(getMainWindow: () => BrowserWindow | null, targetId: string, kind: SshCredentialKind, detail: string): Promise<string | null>;
export declare function registerCredentialHandler(getMainWindow: () => BrowserWindow | null): void;
