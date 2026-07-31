// Why: AppRun may inject --no-sandbox on userns-restricted Linux hosts. When
// ELECTRON_RUN_AS_NODE=1 the binary is plain Node, which rejects that flag
// with "bad option: --no-sandbox" / exit 9 (issue #11609). Rename the real
// binary and place a tiny bash filter in front so CLI wrappers keep working.
const { existsSync, renameSync, writeFileSync, chmodSync } = require('node:fs')
const { join } = require('node:path')

const REAL_BINARY_SUFFIX = '.bin'

function buildLinuxElectronNodeFlagFilterShim(realBinaryRelativeName) {
  const safeName = String(realBinaryRelativeName).replaceAll("'", `'"'"'`)
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    `REAL="$DIR/${safeName}"`,
    'if [ "${ELECTRON_RUN_AS_NODE-}" = "1" ]; then',
    '  args=()',
    '  for a in "$@"; do',
    '    case "$a" in',
    '      --no-sandbox|--disable-setuid-sandbox|--disable-gpu-sandbox) continue ;;',
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
 * @param {string} appOutDir electron-builder linux app output directory
 * @param {string} executableName e.g. orca-ide
 */
function installLinuxElectronNodeFlagFilterShim(appOutDir, executableName) {
  const binaryPath = join(appOutDir, executableName)
  if (!existsSync(binaryPath)) {
    throw new Error(
      `installLinuxElectronNodeFlagFilterShim: missing packaged binary ${binaryPath}`
    )
  }
  const realName = `${executableName}${REAL_BINARY_SUFFIX}`
  const realPath = join(appOutDir, realName)
  if (existsSync(realPath)) {
    throw new Error(
      `installLinuxElectronNodeFlagFilterShim: real binary already exists at ${realPath}`
    )
  }
  renameSync(binaryPath, realPath)
  writeFileSync(binaryPath, buildLinuxElectronNodeFlagFilterShim(realName), 'utf8')
  chmodSync(binaryPath, 0o755)
  return { binaryPath, realPath }
}

module.exports = {
  REAL_BINARY_SUFFIX,
  buildLinuxElectronNodeFlagFilterShim,
  installLinuxElectronNodeFlagFilterShim
}
