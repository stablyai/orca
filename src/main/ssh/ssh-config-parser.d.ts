import type { SshTarget } from '../../shared/ssh-types';
export type SshConfigHost = {
    host: string;
    hostname?: string;
    port?: number;
    user?: string;
    identityFile?: string;
    proxyCommand?: string;
    proxyJump?: string;
};
/**
 * Parse an OpenSSH config file into structured host entries.
 * Handles Host blocks with single or multiple patterns.
 * Ignores wildcard-only patterns (e.g. "Host *").
 */
export declare function parseSshConfig(content: string): SshConfigHost[];
/** Read and parse the user's ~/.ssh/config file. Returns empty array if not found. */
export declare function loadUserSshConfig(): SshConfigHost[];
/** Convert parsed SSH config hosts into SshTarget objects for import. */
export declare function sshConfigHostsToTargets(hosts: SshConfigHost[], existingTargetHosts: Set<string>): SshTarget[];
export type SshResolvedConfig = {
    hostname: string;
    user?: string;
    port: number;
    identityFile: string[];
    forwardAgent: boolean;
    proxyCommand?: string;
    proxyJump?: string;
};
export declare function resolveWithSshG(host: string): Promise<SshResolvedConfig | null>;
export declare function parseSshGOutput(stdout: string): SshResolvedConfig;
