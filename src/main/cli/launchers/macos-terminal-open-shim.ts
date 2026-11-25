import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import { quotePosixShellDoubleQuotedApostrophe } from '../../../shared/shell/launch/shell-argument-quoting'

const SHIM_DIR_NAME = 'macos-open-shim'

/** Routes single http(s) URL opens to Orca when a mobile client is viewing the terminal, else /usr/bin/open. */
export function buildMacosTerminalOpenShimScript(cliLauncher: string | null): string {
  const fallbackCli = quotePosixShellDoubleQuotedApostrophe(cliLauncher ?? 'orca')
  // Keep stderr silent on success: some CLIs treat any stderr output from `open` as failure.
  return `#!/bin/sh
if [ "$#" -eq 1 ] && [ -n "\${ORCA_PANE_KEY:-}" ]; then
  case "$1" in
    http://*|https://*)
      cli="\${ORCA_CLI_COMMAND:-}"
      if [ -z "$cli" ]; then
        cli=${fallbackCli}
      fi
      if "$cli" open-url --url "$1" --if-mobile-viewing --quiet 2>/dev/null; then
        exit 0
      fi
      ;;
  esac
fi
exec /usr/bin/open "$@"
`
}

export function ensureMacosTerminalOpenShimDir(options: {
  userDataPath: string
  cliLauncher: string | null
  platform?: NodeJS.Platform
}): string | null {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return null
  }
  const shimDir = join(options.userDataPath, SHIM_DIR_NAME)
  const shimPath = join(shimDir, 'open')
  const script = buildMacosTerminalOpenShimScript(options.cliLauncher)
  try {
    let existing: string | null = null
    try {
      existing = readFileSync(shimPath, 'utf8')
    } catch {
      existing = null
    }
    if (existing !== script) {
      mkdirSync(shimDir, { recursive: true })
      writeFileAtomically(shimPath, script, { mode: 0o755 })
    }
    chmodSync(shimPath, 0o755)
  } catch {
    return null
  }
  return shimDir
}

export function applyMacosTerminalOpenShimEnv(
  env: Record<string, string>,
  options: {
    userDataPath: string
    cliLauncher: string | null
    isWsl?: boolean
    platform?: NodeJS.Platform
  }
): string | null {
  delete env.ORCA_OPEN_SHIM_DIR
  if (options.isWsl) {
    return null
  }
  const shimDir = ensureMacosTerminalOpenShimDir({
    userDataPath: options.userDataPath,
    cliLauncher: options.cliLauncher,
    platform: options.platform
  })
  if (!shimDir) {
    return null
  }
  env.ORCA_OPEN_SHIM_DIR = shimDir
  const currentPath = env.PATH ?? process.env.PATH ?? ''
  const entries = currentPath.split(':').filter((entry) => entry.length > 0 && entry !== shimDir)
  env.PATH = [shimDir, ...entries].join(':')
  if (env.BROWSER === undefined && process.env.BROWSER === undefined) {
    // Route $BROWSER-aware CLIs (e.g. aws sso, gh) through the same mobile-aware open shim.
    env.BROWSER = 'open'
  }
  return shimDir
}
