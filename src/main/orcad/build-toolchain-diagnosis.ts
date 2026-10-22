/**
 * Diagnose a host's C/C++ build toolchain from a POSIX-sh probe. Pure: it builds a shell
 * command and parses its output, so the Node-only orcad bundle runs it over a local shell.
 */
// Why: a host with no usable node-pty binary needs a C/C++ toolchain to build one (#1693);
// probing lets orcad's blocked report name the install command.
const PROBED_TOOLS = [
  'make',
  'gcc',
  'g++',
  'cc',
  'c++',
  'clang',
  'clang++',
  'python3',
  'python'
] as const

// Package managers mapped to the one-liner that installs a C/C++ toolchain on
// the matching distro family. Ordered by detection priority.
const PACKAGE_MANAGER_HINTS: readonly { bin: string; install: string }[] = [
  { bin: 'apt-get', install: 'sudo apt-get install -y build-essential python3' },
  { bin: 'dnf', install: 'sudo dnf install -y make gcc gcc-c++ python3' },
  { bin: 'yum', install: 'sudo yum install -y make gcc gcc-c++ python3' },
  { bin: 'pacman', install: 'sudo pacman -S --needed base-devel python' },
  { bin: 'apk', install: 'sudo apk add build-base python3' },
  { bin: 'zypper', install: 'sudo zypper install -y gcc gcc-c++ make python3' }
]

type BuildToolchainStatus = {
  present: string[]
  packageManager: string | null
}

// POSIX-sh probe: echo a `HAVE <tool>` line per resolvable build tool and a
// single `PKG <manager>` line for the host's package manager. Runs under
// `/bin/sh -c` (see wrapRemoteCommandForPosixShell), so it stays portable.
export function buildToolchainProbeCommand(): string {
  const toolLoop = `for t in ${PROBED_TOOLS.join(
    ' '
  )}; do if command -v "$t" >/dev/null 2>&1; then echo "HAVE $t"; fi; done`
  const pkgList = PACKAGE_MANAGER_HINTS.map((hint) => hint.bin).join(' ')
  const pkgLoop = `for p in ${pkgList}; do if command -v "$p" >/dev/null 2>&1; then echo "PKG $p"; break; fi; done`
  return `${toolLoop}; ${pkgLoop}`
}

export function parseBuildToolchainProbe(output: string): BuildToolchainStatus {
  const present = new Set<string>()
  let packageManager: string | null = null
  for (const line of output.split('\n')) {
    const haveMatch = line.trim().match(/^HAVE (\S+)$/)
    if (haveMatch) {
      present.add(haveMatch[1])
      continue
    }
    const pkgMatch = line.trim().match(/^PKG (\S+)$/)
    if (pkgMatch && !packageManager) {
      packageManager = pkgMatch[1]
    }
  }
  return {
    present: PROBED_TOOLS.filter((tool) => present.has(tool)),
    packageManager
  }
}

/** Install hint for the host's package manager, or the cross-distro list when it is unknown. */
export function toolchainInstallHintLines(status: BuildToolchainStatus): string[] {
  const tailored = status.packageManager
    ? PACKAGE_MANAGER_HINTS.find((hint) => hint.bin === status.packageManager)?.install
    : null
  if (tailored) {
    return [`  ${tailored}`]
  }
  return [
    '  Debian/Ubuntu:  sudo apt-get install -y build-essential python3',
    '  Fedora/RHEL:    sudo dnf install -y make gcc gcc-c++ python3',
    '  Arch:           sudo pacman -S --needed base-devel python',
    '  Alpine:         sudo apk add build-base python3'
  ]
}
