import { type ChildProcess } from 'child_process';
import { type JsonRpcResponse, type JsonRpcNotification } from './protocol';
export type RelayProcess = {
    proc: ChildProcess;
    responses: (JsonRpcResponse | JsonRpcNotification)[];
    sentinelReceived: Promise<void>;
    send: (method: string, params?: Record<string, unknown>) => number;
    sendNotification: (method: string, params?: Record<string, unknown>) => void;
    waitForResponse: (id: number, timeoutMs?: number) => Promise<JsonRpcResponse>;
    waitForNotification: (method: string, timeoutMs?: number) => Promise<JsonRpcNotification>;
    kill: (signal?: NodeJS.Signals) => void;
    waitForExit: (timeoutMs?: number) => Promise<number | null>;
};
export declare function spawnRelay(entryPath: string, args?: string[]): RelayProcess;
