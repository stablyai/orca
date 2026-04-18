export type WslPathInfo = {
    distro: string;
    linuxPath: string;
};
/**
 * Detect if a Windows path is a WSL UNC path and extract the distro name
 * and equivalent Linux path.
 *
 * Why: Windows exposes WSL filesystems as UNC paths under \\wsl.localhost\<Distro>\...
 * (modern) or \\wsl$\<Distro>\... (legacy). When a repo lives on a WSL filesystem,
 * native Windows git.exe is either absent or painfully slow — all process spawning
 * must be routed through `wsl.exe -d <distro>` with Linux-native paths instead.
 */
export declare function parseWslPath(windowsPath: string): WslPathInfo | null;
export declare function isWslPath(path: string): boolean;
/**
 * Convert a Windows path to a Linux path for commands that will execute inside WSL.
 * Returns the path unchanged if it is already POSIX-style.
 *
 * Why: WSL hook/setup environments may need both the worktree UNC path
 * (\\wsl.localhost\...) and regular Windows install paths (C:\Users\...)
 * translated before passing them to bash. Leaving drive paths untouched
 * breaks scripts that read ORCA_ROOT_PATH or similar env vars inside WSL.
 */
export declare function toLinuxPath(windowsPath: string): string;
/**
 * Convert a Linux path inside a WSL distro to a Windows path.
 *
 * Why two forms: paths under /mnt/<drive>/... are Windows-native filesystem
 * paths that WSL exposes via the DrvFs mount. These map back to their native
 * Windows form (e.g. /mnt/c/Users → C:\Users). All other paths live on the
 * WSL virtual filesystem and use the UNC form (\\wsl.localhost\Distro\...).
 */
export declare function toWindowsWslPath(linuxPath: string, distro: string): string;
/**
 * Get the home directory for a WSL distro, returned as a Windows UNC path.
 * Result is cached per distro for the process lifetime.
 *
 * Why: worktrees for WSL repos are created under ~/orca/workspaces inside
 * the WSL filesystem, mirroring the Windows workspace layout. We need the
 * WSL user's $HOME to compute that path.
 */
export declare function getWslHome(distro: string): string | null;
/**
 * Check whether wsl.exe is available and functional on this Windows machine.
 * Result is cached for the process lifetime.
 */
export declare function isWslAvailable(): boolean;
