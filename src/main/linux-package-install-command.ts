import { quotePosixShellDoubleQuotedApostrophe } from '../shared/shell-argument-quoting'
import { statSync } from 'node:fs'
import path from 'node:path'
import type { LinuxRootPackageType } from '../shared/update-status-types'

// User-writable PATH entries cannot be trusted for privileged package installation.
const TRUSTED_EXECUTABLE_DIRECTORIES = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

const DEB_PACKAGE_MANAGERS: { name: string; args: string[] }[] = [
  { name: 'apt', args: ['install', '--'] },
  { name: 'dpkg', args: ['-i', '--'] }
]

// These tools lack -- support; absolute package paths prevent option injection.
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

export function resolveTrustedExecutable(name: string): string | null {
  for (const directory of TRUSTED_EXECUTABLE_DIRECTORIES) {
    const candidate = path.posix.join(directory, name)
    try {
      const stats = statSync(candidate)
      if (stats.isFile() && (stats.mode & 0o111) !== 0) {
        return candidate
      }
    } catch {}
  }
  return null
}

/** Repackaged installs can inherit a deb/rpm marker without a matching package manager. */
export function hasTrustedPackageManagerFor(packageType: LinuxRootPackageType): boolean {
  const candidates = packageType === 'deb' ? DEB_PACKAGE_MANAGERS : RPM_PACKAGE_MANAGERS
  return candidates.some((candidate) => resolveTrustedExecutable(candidate.name) !== null)
}

/** Produces a command for the user to run and confirm in their terminal. */
export function buildLinuxPackageInstallCommand(
  packageType: LinuxRootPackageType,
  packagePath: string
): LinuxPackageInstallCommandResult {
  // Absolute paths prevent option injection in managers that lack -- support.
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
    const tokens = [
      sudoPath,
      managerPath,
      ...candidate.args,
      quotePosixShellDoubleQuotedApostrophe(packagePath)
    ]
    return { ok: true, command: tokens.join(' ') }
  }
  return { ok: false, reason: 'no-package-manager' }
}
