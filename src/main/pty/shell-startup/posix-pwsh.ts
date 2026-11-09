import { constants as fsConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix as pathPosix } from 'node:path'

// Free of the PowerShell bootstrap imports so the startup PATH/env probes stay light.
const POSIX_PWSH_NAMES = new Set(['pwsh', 'pwsh-preview'])

/** A leading '-' is the login-shell argv[0] convention. */
export function isPosixPwshShell(shellPath: string | null | undefined): boolean {
  if (!shellPath) {
    return false
  }
  const name = pathPosix.basename(shellPath).replace(/^-/, '').toLowerCase()
  return POSIX_PWSH_NAMES.has(name)
}

/** Only honoured as pwsh's first argument; on Unix it re-execs through `/bin/sh -l`. */
export const POSIX_PWSH_LOGIN_ARG = '-Login'

function posixPwshInstallCandidates(name: string): string[] {
  if (name === 'pwsh-preview') {
    // Preview installs side by side under 7-preview, plus the pwsh-preview links Homebrew and deb/rpm/Snap add.
    return process.platform === 'darwin'
      ? [
          '/opt/homebrew/bin/pwsh-preview',
          '/usr/local/bin/pwsh-preview',
          '/usr/local/microsoft/powershell/7-preview/pwsh'
        ]
      : process.platform === 'linux'
        ? [
            '/usr/bin/pwsh-preview',
            '/opt/microsoft/powershell/7-preview/pwsh',
            '/snap/bin/pwsh-preview'
          ]
        : []
  }
  let home = ''
  try {
    home = homedir()
  } catch {
    // No home: skip the per-user installs.
  }
  const dotnetTool = home ? [pathPosix.join(home, '.dotnet', 'tools', 'pwsh')] : []
  if (process.platform === 'darwin') {
    return [
      // Homebrew (Apple silicon, then Intel, where the Microsoft .pkg also links), .pkg payload, MacPorts.
      '/opt/homebrew/bin/pwsh',
      '/usr/local/bin/pwsh',
      '/usr/local/microsoft/powershell/7/pwsh',
      '/opt/local/bin/pwsh',
      ...dotnetTool
    ]
  }
  if (process.platform === 'linux') {
    return [
      // deb/rpm, tarball, Snap, Linuxbrew.
      '/usr/bin/pwsh',
      '/usr/local/bin/pwsh',
      '/opt/microsoft/powershell/7/pwsh',
      '/snap/bin/pwsh',
      '/home/linuxbrew/.linuxbrew/bin/pwsh',
      ...(home ? [pathPosix.join(home, '.linuxbrew', 'bin', 'pwsh')] : []),
      ...dotnetTool
    ]
  }
  return []
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** True for a bare pwsh name on macOS/Linux, the only input resolvePosixPaneShellPath changes. */
export function needsPosixPaneShellResolution(shellPath: string): boolean {
  return process.platform !== 'win32' && !shellPath.includes('/') && isPosixPwshShell(shellPath)
}

/** Bare pwsh -> absolute path via the spawn PATH, then installs a Finder/desktop-entry PATH misses. */
export async function resolvePosixPaneShellPath(
  shellPath: string,
  spawnPathValue = process.env.PATH ?? '',
  spawnCwd = process.cwd()
): Promise<string> {
  if (!needsPosixPaneShellResolution(shellPath)) {
    return shellPath
  }
  for (const dir of spawnPathValue.split(':')) {
    // Empty and relative entries resolve against the child's cwd, as execvp does.
    const candidate = pathPosix.resolve(spawnCwd, dir, shellPath)
    if (await isExecutableFile(candidate)) {
      return candidate
    }
  }
  for (const candidate of posixPwshInstallCandidates(shellPath)) {
    if (await isExecutableFile(candidate)) {
      return candidate
    }
  }
  return shellPath
}
