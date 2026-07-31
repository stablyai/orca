/**
 * Chromium-only flags AppRun may inject on userns-restricted Linux hosts.
 * ELECTRON_RUN_AS_NODE mode is plain Node, which rejects these with
 * "bad option: --no-sandbox" / exit 9 (issue #11609).
 */
export const CHROMIUM_ONLY_ELECTRON_FLAGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu-sandbox'
] as const

const CHROMIUM_ONLY_FLAG_SET = new Set<string>(CHROMIUM_ONLY_ELECTRON_FLAGS)

/**
 * Drop Chromium-only flags from an argv list when running as Node.
 * Does not mutate the input array.
 */
export function stripChromiumOnlyFlagsForNodeMode(argv: readonly string[]): string[] {
  return argv.filter((arg) => !CHROMIUM_ONLY_FLAG_SET.has(arg))
}

/**
 * Shell shim placed in front of the packaged Electron binary on Linux.
 * When ELECTRON_RUN_AS_NODE=1, strip Chromium-only flags before exec'ing the real binary.
 *
 * @param realBinaryRelativeName basename of the renamed real binary (e.g. orca-ide.bin)
 */
export function buildLinuxElectronNodeFlagFilterShim(realBinaryRelativeName: string): string {
  // Keep the shim dependency-free bash so packaging can drop it next to the binary.
  return `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
REAL="$DIR/${realBinaryRelativeName.replaceAll("'", `'"'"'`)}"
if [ "\${ELECTRON_RUN_AS_NODE-}" = "1" ]; then
  args=()
  for a in "$@"; do
    case "$a" in
      --no-sandbox|--disable-setuid-sandbox|--disable-gpu-sandbox) continue ;;
      *) args+=("$a") ;;
    esac
  done
  exec "$REAL" "\${args[@]}"
fi
exec "$REAL" "$@"
`
}
