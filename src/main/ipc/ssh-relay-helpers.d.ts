import type { BrowserWindow } from 'electron';
import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer';
import { SshPtyProvider } from '../providers/ssh-pty-provider';
import type { SshPortForwardManager } from '../ssh/ssh-port-forward';
import type { SshConnectionManager } from '../ssh/ssh-connection';
export declare function cleanupConnection(targetId: string, activeMultiplexers: Map<string, SshChannelMultiplexer>, initializedConnections: Set<string>, portForwardManager: SshPortForwardManager | null): void;
export declare function wireUpSshPtyEvents(ptyProvider: SshPtyProvider, getMainWindow: () => BrowserWindow | null): void;
export declare function reestablishRelayStack(targetId: string, getMainWindow: () => BrowserWindow | null, connectionManager: SshConnectionManager | null, activeMultiplexers: Map<string, SshChannelMultiplexer>, portForwardManager?: SshPortForwardManager | null): Promise<void>;
