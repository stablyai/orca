import { type BrowserWindow } from 'electron';
export { getBashShellReadyRcfileContent } from '../providers/local-pty-shell-ready';
import type { OrcaRuntimeService } from '../runtime/orca-runtime';
import type { GlobalSettings } from '../../shared/types';
import { LocalPtyProvider } from '../providers/local-pty-provider';
import type { IPtyProvider } from '../providers/types';
/** Register an SSH PTY provider for a connection. */
export declare function registerSshPtyProvider(connectionId: string, provider: IPtyProvider): void;
/** Remove an SSH PTY provider when a connection is closed. */
export declare function unregisterSshPtyProvider(connectionId: string): void;
/** Get the SSH PTY provider for a connection (for dispose on cleanup). */
export declare function getSshPtyProvider(connectionId: string): IPtyProvider | undefined;
/** Get the local PTY provider (for direct access in tests/runtime). */
export declare function getLocalPtyProvider(): LocalPtyProvider;
/** Replace the local PTY provider with a daemon-backed one.
 *  Call before registerPtyHandlers so the IPC layer routes through the daemon. */
export declare function setLocalPtyProvider(provider: IPtyProvider): void;
/** Get all PTY IDs owned by a given connectionId (for reconnection reattach). */
export declare function getPtyIdsForConnection(connectionId: string): string[];
/**
 * Remove all PTY ownership entries for a given connectionId.
 * Why: when an SSH connection is closed, the remote PTYs are gone but their
 * ownership entries linger. Without cleanup, subsequent spawn calls could
 * look up a stale provider for those PTY IDs, and the map grows unboundedly.
 */
export declare function clearPtyOwnershipForConnection(connectionId: string): void;
export declare function clearProviderPtyState(id: string): void;
export declare function deletePtyOwnership(id: string): void;
export declare function registerPtyHandlers(mainWindow: BrowserWindow, runtime?: OrcaRuntimeService, getSelectedCodexHomePath?: () => string | null, getSettings?: () => GlobalSettings): void;
/**
 * Kill all PTY processes. Call on app quit.
 */
export declare function killAllPty(): void;
