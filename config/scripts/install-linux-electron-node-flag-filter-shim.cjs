// Why: AppRun may inject --no-sandbox on userns-restricted Linux hosts. When
// ELECTRON_RUN_AS_NODE=1 the binary is plain Node, which rejects that flag
// with "bad option: --no-sandbox" / exit 9 (issue #11609). Rename the real
// binary and place a tiny bash filter in front so CLI wrappers keep working.
//
// Single source of truth for packaging (electron-builder afterPack). Do not
// reimplement the shim in TypeScript — tests import this module directly.
const {
  chmodSync,
  existsSync,
  renameSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { join } = require('node:path')

const REAL_BINARY_SUFFIX = '.bin'

/** Chromium-only flags AppRun may prepend; Node mode must drop them. */
const CHROMIUM_ONLY_ELECTRON_FLAGS = Object.freeze([
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu-sandbox'
])

const CHROMIUM_ONLY_FLAG_SET = new Set(CHROMIUM_ONLY_ELECTRON_FLAGS)

/**
 * Drop Chromium-only flags from an argv list when running as Node.
 * Does not mutate the input array.
 * @param {readonly string[]} argv
 * @returns {string[]}
 */
function stripChromiumOnlyFlagsForNodeMode(argv) {
  return argv.filter((arg) => !CHROMIUM_ONLY_FLAG_SET.has(arg))
}

/**
 * Shell shim placed in front of the packaged Electron binary on Linux.
 * When ELECTRON_RUN_AS_NODE=1, strip Chromium-only flags before exec'ing the real binary.
 * Flag list is derived from CHROMIUM_ONLY_ELECTRON_FLAGS (no second hard-coded list).
 *
 * @param {string} realBinaryRelativeName basename of the renamed real binary (e.g. orca-ide.bin)
 * @returns {string}
 */
function buildLinuxElectronNodeFlagFilterShim(realBinaryRelativeName) {
  const safeName = String(realBinaryRelativeName).replaceAll("'", `'"'"'`)
  const flagPattern = CHROMIUM_ONLY_ELECTRON_FLAGS.join('|')
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    // Why: resolve through symlinks so REAL stays next to the real binary when
    // the shim path is a link (deb/AppImage PATH wrappers).
    'DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"',
    `REAL="$DIR/${safeName}"`,
    'if [ "${ELECTRON_RUN_AS_NODE-}" = "1" ]; then',
    '  args=()',
    '  for a in "$@"; do',
    '    case "$a" in',
    `      ${flagPattern}) continue ;;`,
    '      *) args+=("$a") ;;',
    '    esac',
    '  done',
    '  exec "$REAL" "${args[@]}"',
    'fi',
    'exec "$REAL" "$@"',
    ''
  ].join('\n')
}

/**
 * Install the Node-mode flag filter in front of the packaged Linux binary.
 * Write shim to a temp name first, then rename into place so a crash mid-step
 * never leaves `orca-ide` missing without a recovery path.
 *
 * @param {string} appOutDir electron-builder linux app output directory
 * @param {string} executableName e.g. orca-ide
 */
function installLinuxElectronNodeFlagFilterShim(appOutDir, executableName) {
  const binaryPath = join(appOutDir, executableName)
  const realName = `${executableName}${REAL_BINARY_SUFFIX}`
  const realPath = join(appOutDir, realName)
  const shimTmpPath = join(appOutDir, `${executableName}.shim.tmp`)

  // Recovery: previous run renamed the binary but never finished the shim.
  if (!existsSync(binaryPath) && existsSync(realPath)) {
    writeFileSync(shimTmpPath, buildLinuxElectronNodeFlagFilterShim(realName), 'utf8')
    chmodSync(shimTmpPath, 0o755)
    renameSync(shimTmpPath, binaryPath)
    return { binaryPath, realPath, recovered: true }
  }

  if (!existsSync(binaryPath)) {
    throw new Error(
      `installLinuxElectronNodeFlagFilterShim: missing packaged binary ${binaryPath}`
    )
  }

  if (existsSync(realPath)) {
    // Shim already installed (idempotent re-run after a clean pack).
    if (existsSync(binaryPath)) {
      writeFileSync(shimTmpPath, buildLinuxElectronNodeFlagFilterShim(realName), 'utf8')
      chmodSync(shimTmpPath, 0o755)
      renameSync(shimTmpPath, binaryPath)
      return { binaryPath, realPath, recovered: false }
    }
    throw new Error(
      `installLinuxElectronNodeFlagFilterShim: real binary already exists at ${realPath}`
    )
  }

  // 1) Materialize the shim next to the binary (does not remove the binary yet).
  writeFileSync(shimTmpPath, buildLinuxElectronNodeFlagFilterShim(realName), 'utf8')
  chmodSync(shimTmpPath, 0o755)
  // 2) Move the real Electron binary out of the way.
  renameSync(binaryPath, realPath)
  // 3) Atomic rename of the ready shim into the public executable name.
  try {
    renameSync(shimTmpPath, binaryPath)
  } catch (error) {
    // Best-effort restore so a failed pack does not strand only orca-ide.bin.
    try {
      if (existsSync(realPath) && !existsSync(binaryPath)) {
        renameSync(realPath, binaryPath)
      }
    } catch {
      // ignore restore failures; surface the original error
    }
    try {
      if (existsSync(shimTmpPath)) {
        rmSync(shimTmpPath, { force: true })
      }
    } catch {
      // ignore
    }
    throw error
  }

  return { binaryPath, realPath, recovered: false }
}

module.exports = {
  REAL_BINARY_SUFFIX,
  CHROMIUM_ONLY_ELECTRON_FLAGS,
  stripChromiumOnlyFlagsForNodeMode,
  buildLinuxElectronNodeFlagFilterShim,
  installLinuxElectronNodeFlagFilterShim
}
