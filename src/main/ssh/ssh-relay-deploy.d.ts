import type { SshConnection } from './ssh-connection';
import { type RelayPlatform } from './relay-protocol';
import type { MultiplexerTransport } from './ssh-channel-multiplexer';
export type RelayDeployResult = {
    transport: MultiplexerTransport;
    platform: RelayPlatform;
};
/**
 * Deploy the relay to the remote host and launch it.
 *
 * Steps:
 * 1. Detect remote OS/arch via `uname -sm`
 * 2. Check if correct relay version is already deployed
 * 3. If not, SCP the relay package
 * 4. Launch relay via exec channel
 * 5. Wait for ORCA-RELAY sentinel on stdout
 * 6. Return the transport (relay's stdin/stdout) for multiplexer use
 */
export declare function deployAndLaunchRelay(conn: SshConnection, onProgress?: (status: string) => void): Promise<RelayDeployResult>;
