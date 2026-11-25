import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'

const SHIM_DIR_NAME = 'macos-open-shim'

/** Routes single http(s) URL opens to Orca when a mobile client is viewing the terminal, else /usr/bin/open. */
export function buildMacosTerminalOpenShimScript(cliLauncher: string | null): string {
  const fallbackCli = quotePosixShell(cliLauncher ?? 'orca')
  // Keep stderr silent on success: some CLIs treat any stderr output from `open` as failure.
  // Pass --environment local so ambient ORCA_ENVIRONMENT / ORCA_PAIRING_CODE never misroutes local opens.
  return `#!/bin/sh
if [ "$#" -eq 1 ] && [ -n "\${ORCA_PANE_KEY:-}" ]; then
  case "$1" in
    http://*|https://*)
      cli="\${ORCA_CLI_COMMAND:-}"
      if [ -z "$cli" ]; then
        cli=${fallbackCli}
      fi
      if "$cli" open-url --environment local --url "$1" --if-mobile-viewing --quiet 2>/dev/null; then
        exit 0
      fi
      ;;
  esac
fi
exec /usr/bin/open "$@"
`
}

export async function ensureMacosTerminalOpenShimDir(options: {
  userDataPath: string
  cliLauncher: string | null
  platform?: NodeJS.Platform
}): Promise<string | null> {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return null
  }
  const shimDir = join(options.userDataPath, SHIM_DIR_NAME)
  const shimPath = join(shimDir, 'open')
  const script = buildMacosTerminalOpenShimScript(options.cliLauncher)
  try {
    let existing: string | null = null
    try {
      existing = await readFile(shimPath, 'utf8')
    } catch {
      existing = null
    }
    if (existing !== script) {
      await mkdir(shimDir, { recursive: true })
      const tempPath = `${shimPath}.${randomUUID()}.tmp`
      try {
        await writeFile(tempPath, script, { mode: 0o755 })
        // Apply explicit mode before rename so restrictive umasks never expose a non-executable shim.
        await chmod(tempPath, 0o755)
        await rename(tempPath, shimPath)
      } catch (error) {
        await unlink(tempPath).catch(() => {})
        throw error
      }
    }
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
  const previousShimDir = env.ORCA_OPEN_SHIM_DIR
  delete env.ORCA_OPEN_SHIM_DIR
  const platform = options.platform ?? process.platform
  if (options.isWsl || platform !== 'darwin') {
    if (previousShimDir && env.PATH) {
      env.PATH = env.PATH.split(':')
        .filter((entry) => entry.length > 0 && entry !== previousShimDir)
        .join(':')
    }
    return null
  }
  const shimDir = join(options.userDataPath, SHIM_DIR_NAME)
  void ensureMacosTerminalOpenShimDir(options)
  env.ORCA_OPEN_SHIM_DIR = shimDir
  const currentPath = env.PATH ?? process.env.PATH ?? ''
  const entries = currentPath
    .split(':')
    .filter((entry) => entry.length > 0 && entry !== shimDir && entry !== previousShimDir)
  env.PATH = [shimDir, ...entries].join(':')
  if (env.BROWSER === undefined && process.env.BROWSER === undefined) {
    // Route $BROWSER-aware CLIs (e.g. aws sso, gh) through the same mobile-aware open shim.
    env.BROWSER = 'open'
  }
  return shimDir
}
