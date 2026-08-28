/**
 * Diagnose a host's C/C++ build toolchain from a POSIX-sh probe.
 *
 * Why this is separate from `ssh-relay-build-toolchain.ts`: everything here is pure —
 * it builds a shell command, parses its output, and formats messages. The relay reaches
 * it over SSH; `orcad` reaches it over a local shell. Keeping it transport-free is what
 * lets the Node-only bundle reuse it without pulling `ssh2` in behind it.
 */
// Why: node-pty@1.1.0 ships no Linux prebuild, so the remote `npm install` falls
// back to `node-gyp rebuild` and needs a C/C++ toolchain. A missing toolchain is
// the dominant first-connect failure on Linux relays (#1693); node-gyp surfaces
// it as an opaque `not found: make`. We probe for the tools so we can replace
// that with an actionable "install build-essential" message.
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

export type BuildToolchainStatus = {
  present: string[]
  packageManager: string | null
  // node-gyp needs make, Python, and a C++ compiler. The caller only uses this
  // verdict after npm/node-gyp output already points at a native-build failure,
  // so custom Python paths do not make unrelated npm failures look toolchainy.
  toolchainMissing: boolean
}

function hasCxxCompiler(present: ReadonlySet<string>): boolean {
  return present.has('g++') || present.has('c++') || present.has('clang++')
}

function hasPython(present: ReadonlySet<string>): boolean {
  return present.has('python3') || present.has('python')
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
    packageManager,
    toolchainMissing: !present.has('make') || !hasCxxCompiler(present) || !hasPython(present)
  }
}

export function shouldProbeBuildToolchainAfterNativeDepsFailure(message: string): boolean {
  const lower = message.toLowerCase()
  if (!lower.includes('gyp') && !lower.includes('node-gyp')) {
    return false
  }
  return (
    /\bnot found:\s*(make|gmake|gcc|g\+\+|cc|c\+\+|clang|clang\+\+|python|python3)\b/i.test(
      message
    ) ||
    /\b(make|gmake|gcc|g\+\+|cc|c\+\+|clang|clang\+\+|python|python3)\b.*\bnot found\b/i.test(
      message
    ) ||
    lower.includes('could not find any python installation') ||
    lower.includes('no xcode or clt version detected')
  )
}

function missingToolNames(status: BuildToolchainStatus): string[] {
  const present = new Set(status.present)
  const missing: string[] = []
  if (!present.has('make')) {
    missing.push('make')
  }
  if (!hasCxxCompiler(present)) {
    missing.push('a C++ compiler (g++ or clang++)')
  }
  if (!hasPython(present)) {
    missing.push('python3')
  }
  return missing
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

/** One-line summary for the deploy log when node-pty is skipped rather than compiled. */
export function formatSkippedNodePtyWarning(status: BuildToolchainStatus): string {
  // Why: with no package manager detected the hint list is the cross-distro menu, whose first line
  // is Debian's — quoting it alone would name the wrong distro, so stay neutral instead.
  const hintLines = toolchainInstallHintLines(status)
  const hint =
    hintLines.length === 1
      ? hintLines[0].trim()
      : 'install a C/C++ toolchain (make, a C++ compiler, python3)'
  return (
    `missing build tools (${missingToolNames(status).join(', ')}); skipping node-pty so the ` +
    `connection still serves files and git. Remote terminals need: ${hint}`
  )
}

export function formatMissingToolchainError(
  status: BuildToolchainStatus,
  underlyingError: string
): string {
  const lines = [
    `The remote host is missing the C/C++ build tools (${missingToolNames(status).join(', ')}) ` +
      `needed to compile Orca's relay native modules (node-pty, @parcel/watcher). node-pty has no ` +
      `prebuilt binary for Linux, so they must be compiled on the remote host.`,
    '',
    'Install the build tools on the remote host, then reconnect:',
    ...toolchainInstallHintLines(status),
    '',
    `Underlying install error: ${underlyingError}`
  ]
  return lines.join('\n')
}

