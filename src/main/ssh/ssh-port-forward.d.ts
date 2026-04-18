import type { SshConnection } from './ssh-connection';
export type PortForwardEntry = {
    id: string;
    connectionId: string;
    localPort: number;
    remoteHost: string;
    remotePort: number;
    label?: string;
};
export declare class SshPortForwardManager {
    private forwards;
    private nextId;
    addForward(connectionId: string, conn: SshConnection, localPort: number, remoteHost: string, remotePort: number, label?: string): Promise<PortForwardEntry>;
    removeForward(id: string): boolean;
    listForwards(connectionId?: string): PortForwardEntry[];
    removeAllForwards(connectionId: string): void;
    dispose(): void;
}
