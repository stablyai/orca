import { type ChildProcess } from 'child_process';
import type { Socket as NetSocket } from 'net';
import type { ConnectConfig } from 'ssh2';
import type { SshTarget, SshConnectionState } from '../../shared/ssh-types';
import type { SshResolvedConfig } from './ssh-config-parser';
export type SshCredentialKind = 'passphrase' | 'password';
export type SshConnectionCallbacks = {
    onStateChange: (targetId: string, state: SshConnectionState) => void;
    onCredentialRequest?: (targetId: string, kind: SshCredentialKind, detail: string) => Promise<string | null>;
};
export declare function isPassphraseError(err: Error): boolean;
export declare const INITIAL_RETRY_ATTEMPTS = 5;
export declare const INITIAL_RETRY_DELAY_MS = 2000;
export declare const RECONNECT_BACKOFF_MS: number[];
export declare const CONNECT_TIMEOUT_MS = 30000;
export declare function isAuthError(err: Error): boolean;
export declare function isTransientError(err: Error): boolean;
export declare function sleep(ms: number): Promise<void>;
export declare function shellEscape(s: string): string;
export declare function findDefaultKeyFile(): {
    path: string;
    contents: Buffer;
} | undefined;
export declare function buildConnectConfig(target: SshTarget, resolved: SshResolvedConfig | null): ConnectConfig;
export type EffectiveProxy = {
    kind: 'proxy-command';
    command: string;
} | {
    kind: 'jump-host';
    jumpHost: string;
};
export declare function resolveEffectiveProxy(target: SshTarget, resolved: SshResolvedConfig | null): EffectiveProxy | undefined;
export declare function spawnProxyCommand(proxy: EffectiveProxy, host: string, port: number, user: string): {
    process: ChildProcess;
    sock: NetSocket;
};
