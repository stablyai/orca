import { quotePosixShellDoubleQuotedApostrophe } from '../../../shared/shell/launch/shell-argument-quoting'
import { statSync } from 'node:fs'
import path from 'node:path'
import type { LinuxRootPackageType } from '../../../shared/updater/update-status-types'

// User-writable PATH entries cannot be trusted for privileged package installation.
const TRUSTED_EXECUTABLE_DIRECTORIES = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

type PackageManagerStep = { name: string; args: string[] }
/** Steps run in order under one shell line; all must resolve or the candidate is skipped. */
type PackageManagerCandidate = PackageManagerStep[]

// Why: a same-version install is a no-op even when a failed attempt left the files damaged (measured
// on dnf5, apt 2.8, zypper 1.14 and rpm 4.20), so every candidate must also repair that state.
const DEB_PACKAGE_MANAGERS: PackageManagerCandidate[] = [
  [
    // Preset apt's own root fallback for file: reads (_apt can't read ~/.cache); network methods stay sandboxed.
    // --reinstall also installs when absent and upgrades when older, so it replaces a bare install.
    {
      name: 'apt',
      args: ['-o', 'Binary::file::APT::Sandbox::User=root', 'install', '--reinstall', '--']
    }
  ],
  // dpkg -i re-unpacks unconditionally, so it needs no repair flag.
  [{ name: 'dpkg', args: ['-i', '--'] }]
]

// These tools lack -- support; absolute package paths prevent option injection.
// dnf/yum repair first: `reinstall` fixes a damaged same-version install, `install` covers absent and
// older. Both no-ops exit 0, so they are joined with `;` — `install || reinstall` would never repair.
const RPM_PACKAGE_MANAGERS: PackageManagerCandidate[] = [
  // -f already reinstalls a damaged same-version package, and install still upgrades (measured).
  [{ name: 'zypper', args: ['--no-refresh', 'install', '--allow-unsigned-rpm', '-f'] }],
  [
    { name: 'dnf', args: ['reinstall', '--nogpgcheck'] },
    { name: 'dnf', args: ['install', '--nogpgcheck'] }
  ],
  [
    { name: 'yum', args: ['reinstall', '--nogpgcheck'] },
    { name: 'yum', args: ['install', '--nogpgcheck'] }
  ],
  // rpm -Uvh refuses an already-installed version; --replacepkgs makes it re-unpack anyway.
  [{ name: 'rpm', args: ['-Uvh', '--replacepkgs'] }]
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
  return candidates.some((candidate) =>
    candidate.some((step) => resolveTrustedExecutable(step.name) !== null)
  )
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
    const commands: string[] = []
    let resolvable = true
    for (const step of candidate) {
      const managerPath = resolveTrustedExecutable(step.name)
      if (!managerPath) {
        resolvable = false
        break
      }
      // No -y/--noconfirm: the user must see and confirm the privileged transaction.
      commands.push(
        [
          sudoPath,
          managerPath,
          ...step.args,
          quotePosixShellDoubleQuotedApostrophe(packagePath)
        ].join(' ')
      )
    }
    if (resolvable) {
      return { ok: true, command: commands.join(' ; ') }
    }
  }
  return { ok: false, reason: 'no-package-manager' }
}
