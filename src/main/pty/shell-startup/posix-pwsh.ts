import { accessSync, statSync, constants as fsConstants } from 'node:fs'
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

function posixPwshInstallCandidates(): string[] {
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

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Bare pwsh -> absolute path via the spawn PATH, then installs a Finder/desktop-entry PATH misses. */
export function resolvePosixPaneShellPath(
  shellPath: string,
  spawnPathValue = process.env.PATH ?? ''
): string {
  if (process.platform === 'win32' || shellPath.includes('/') || !isPosixPwshShell(shellPath)) {
    return shellPath
  }
  for (const dir of spawnPathValue.split(':')) {
    const candidate = pathPosix.isAbsolute(dir) ? pathPosix.join(dir, shellPath) : null
    if (candidate && isExecutableFile(candidate)) {
      return candidate
    }
  }
  // Preview builds share no install location, so only stable pwsh gets the fallback search.
  const installed =
    shellPath === 'pwsh' ? posixPwshInstallCandidates().find(isExecutableFile) : null
  return installed ?? shellPath
}
