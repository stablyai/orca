import type { RuntimeTransportMetadata } from '../../shared/runtime-bootstrap';
import type { OrcaRuntimeService } from './orca-runtime';
type OrcaRuntimeRpcServerOptions = {
    runtime: OrcaRuntimeService;
    userDataPath: string;
    pid?: number;
    platform?: NodeJS.Platform;
};
export declare class OrcaRuntimeRpcServer {
    private readonly runtime;
    private readonly userDataPath;
    private readonly pid;
    private readonly platform;
    private readonly authToken;
    private server;
    private transport;
    constructor({ runtime, userDataPath, pid, platform }: OrcaRuntimeRpcServerOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
    private handleConnection;
    private handleMessage;
    private errorResponse;
    private runtimeErrorResponse;
    private writeMetadata;
}
export declare function createRuntimeTransportMetadata(userDataPath: string, pid: number, platform: NodeJS.Platform, runtimeId?: string): RuntimeTransportMetadata;
export {};
