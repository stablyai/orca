import { statSync } from 'node:fs'
import path from 'node:path'
import type { LinuxRootPackageType } from '../shared/types'

// Why: an absolute but user-writable PATH entry must never be treated as a trusted package manager.
const TRUSTED_EXECUTABLE_DIRECTORIES = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

const DEB_PACKAGE_MANAGERS: { name: string; args: string[] }[] = [
  { name: 'apt', args: ['install', '--'] },
  { name: 'dpkg', args: ['-i', '--'] }
]

// No `--` terminator: these tools do not accept one. Safe because capture requires an absolute path,
// so the argument can never be read as an option.
const RPM_PACKAGE_MANAGERS: { name: string; args: string[] }[] = [
  {
    name: 'zypper',
    args: ['--no-refresh', 'install', '--allow-unsigned-rpm', '-f']
  },
  { name: 'dnf', args: ['install', '--nogpgcheck'] },
  { name: 'yum', args: ['install', '--nogpgcheck'] },
  { name: 'rpm', args: ['-Uvh'] }
]

export type LinuxPackageInstallCommandResult =
  | { ok: true; command: string }
  | { ok: false; reason: 'no-sudo' | 'no-package-manager' | 'invalid-package-path' }

/** POSIX single-quoting: the only metacharacter left is `'`, closed and re-opened around a literal. */
export function quoteForPosixShell(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`
}

/**
 * Resolves an executable strictly from the trusted system directories. A symlink inside those
 * directories is fine — its target is what `statSync` checks — but nothing outside them is consulted
 * and no shell is ever invoked for discovery.
 */
export function resolveTrustedExecutable(name: string): string | null {
  for (const directory of TRUSTED_EXECUTABLE_DIRECTORIES) {
    // posix.join: these are POSIX paths, and this module only ever runs on Linux.
    const candidate = path.posix.join(directory, name)
    try {
      const stats = statSync(candidate)
      if (stats.isFile() && (stats.mode & 0o111) !== 0) {
        return candidate
      }
    } catch {
      // Absent here; keep looking in the remaining trusted directories.
    }
  }
  return null
}

/**
 * Builds the interactive command the user pastes into their own terminal. Every token except the
 * package path is a fixed literal, and the path is POSIX-single-quoted — Orca never runs this.
 */
export function buildLinuxPackageInstallCommand(
  packageType: LinuxRootPackageType,
  packagePath: string
): LinuxPackageInstallCommandResult {
  // Why: several package managers accept no `--` terminator, so a relative or dash-leading path would
  // be read as an option. Hold that property here rather than relying on a caller two modules away.
  if (!path.isAbsolute(packagePath)) {
    return { ok: false, reason: 'invalid-package-path' }
  }
  const sudoPath = resolveTrustedExecutable('sudo')
  if (!sudoPath) {
    return { ok: false, reason: 'no-sudo' }
  }
  const candidates = packageType === 'deb' ? DEB_PACKAGE_MANAGERS : RPM_PACKAGE_MANAGERS
  for (const candidate of candidates) {
    const managerPath = resolveTrustedExecutable(candidate.name)
    if (!managerPath) {
      continue
    }
    // No -y/--noconfirm: the user must see and confirm the privileged transaction.
    const tokens = [sudoPath, managerPath, ...candidate.args, quoteForPosixShell(packagePath)]
    return { ok: true, command: tokens.join(' ') }
  }
  return { ok: false, reason: 'no-package-manager' }
}
