import type { SshTarget } from '../../shared/ssh-types';
export type SystemSshProcess = {
    stdin: NodeJS.WritableStream;
    stdout: NodeJS.ReadableStream;
    stderr: NodeJS.ReadableStream;
    kill: () => void;
    onExit: (cb: (code: number | null) => void) => void;
    pid: number | undefined;
};
/**
 * Find the system ssh binary path. Returns null if not found.
 */
export declare function findSystemSsh(): string | null;
/**
 * Spawn a system ssh process connecting to the given target.
 * Used when ssh2 cannot handle the auth method (FIDO2, ControlMaster).
 *
 * The returned process's stdin/stdout are used as the transport for
 * the relay's JSON-RPC protocol, exactly like an ssh2 channel.
 */
export declare function spawnSystemSsh(target: SshTarget): SystemSshProcess;
