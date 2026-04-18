import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer';
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from './types';
type DataCallback = (payload: {
    id: string;
    data: string;
}) => void;
type ReplayCallback = (payload: {
    id: string;
    data: string;
}) => void;
type ExitCallback = (payload: {
    id: string;
    code: number;
}) => void;
/**
 * Remote PTY provider that proxies all operations through the relay
 * via the JSON-RPC multiplexer. Implements the same IPtyProvider interface
 * as LocalPtyProvider so the dispatch layer can route transparently.
 */
export declare class SshPtyProvider implements IPtyProvider {
    private mux;
    private connectionId;
    private dataListeners;
    private replayListeners;
    private exitListeners;
    private unsubscribeNotifications;
    constructor(connectionId: string, mux: SshChannelMultiplexer);
    dispose(): void;
    getConnectionId(): string;
    spawn(opts: PtySpawnOptions): Promise<PtySpawnResult>;
    attach(id: string): Promise<void>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    shutdown(id: string, immediate: boolean): Promise<void>;
    sendSignal(id: string, signal: string): Promise<void>;
    getCwd(id: string): Promise<string>;
    getInitialCwd(id: string): Promise<string>;
    clearBuffer(id: string): Promise<void>;
    acknowledgeDataEvent(id: string, charCount: number): void;
    hasChildProcesses(id: string): Promise<boolean>;
    getForegroundProcess(id: string): Promise<string | null>;
    serialize(ids: string[]): Promise<string>;
    revive(state: string): Promise<void>;
    listProcesses(): Promise<{
        id: string;
        cwd: string;
        title: string;
    }[]>;
    getDefaultShell(): Promise<string>;
    getProfiles(): Promise<{
        name: string;
        path: string;
    }[]>;
    onData(callback: DataCallback): () => void;
    onReplay(callback: ReplayCallback): () => void;
    onExit(callback: ExitCallback): () => void;
}
export {};
