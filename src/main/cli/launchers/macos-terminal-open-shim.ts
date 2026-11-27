import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import { isPathInsideOrEqual } from '../command-paths/cli-install-path-format'

const SHIM_DIR_NAME = 'macos-open-shim'
const ensuredShimKeys = new Set<string>()

async function writeExecutableIfChanged(filePath: string, content: string): Promise<void> {
  let existing: string | null = null
  try {
    existing = await readFile(filePath, 'utf8')
  } catch {
    existing = null
  }
  if (existing === content) {
    return
  }
  await mkdir(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, content, { mode: 0o755 })
    // Apply explicit mode before rename so restrictive umasks never expose a non-executable shim.
    await chmod(tempPath, 0o755)
    await rename(tempPath, filePath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
}

/** Routes single http(s) URL opens to Orca when a mobile client is viewing the terminal, else /usr/bin/open. */
export function buildMacosTerminalOpenShimScript(cliLauncher: string | null): string {
  // Pin this instance's launcher so dev/nested shells never invoke an outer Orca.app's older CLI.
  const cliAssignment = cliLauncher
    ? `cli=${quotePosixShell(cliLauncher)}`
    : 'cli="${ORCA_CLI_COMMAND:-orca}"'
  // Keep stderr silent on success: some CLIs treat any stderr output from `open` as failure.
  // Pass --environment local so ambient ORCA_ENVIRONMENT / ORCA_PAIRING_CODE never misroutes local opens.
  return `#!/bin/sh
pane_key="\${ORCA_PANE_KEY:-\${ORCA_AGENT_PANE:-}}"
if [ "$#" -eq 1 ] && [ -n "$pane_key" ]; then
  case "$1" in
    http://*|https://*)
      ${cliAssignment}
      if ORCA_PANE_KEY="$pane_key" "$cli" open-url --environment local --url "$1" --if-mobile-viewing --quiet 2>/dev/null; then
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
  const script = buildMacosTerminalOpenShimScript(options.cliLauncher)
  try {
    await writeExecutableIfChanged(join(shimDir, 'open'), script)
    if (options.cliLauncher && resolve(dirname(options.cliLauncher)) !== resolve(shimDir)) {
      // Expose `orca` (and `orca-dev`) inside shimDir so ORCA_CLI_BIN_DIR=shimDir works on pre-update orcad daemons.
      const forwarder = `#!/bin/sh\nexec ${quotePosixShell(options.cliLauncher)} "$@"\n`
      await writeExecutableIfChanged(join(shimDir, 'orca'), forwarder)
      const launcherName = basename(options.cliLauncher)
      if (launcherName !== 'orca' && launcherName !== 'open') {
        await writeExecutableIfChanged(join(shimDir, launcherName), forwarder)
      }
      const launcherDir = dirname(options.cliLauncher)
      if (
        resolve(launcherDir) !== resolve(options.userDataPath) &&
        isPathInsideOrEqual(resolve(options.userDataPath), resolve(launcherDir))
      ) {
        await writeExecutableIfChanged(join(launcherDir, 'open'), script)
      }
    }
    ensuredShimKeys.add(`${options.userDataPath}\0${options.cliLauncher ?? ''}`)
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
  if (options.isWsl || (options.platform ?? process.platform) !== 'darwin') {
    return null
  }
  const shimDir = join(options.userDataPath, SHIM_DIR_NAME)
  if (!ensuredShimKeys.has(`${options.userDataPath}\0${options.cliLauncher ?? ''}`)) {
    void ensureMacosTerminalOpenShimDir(options)
  }
  if (options.cliLauncher || !env.ORCA_CLI_BIN_DIR) {
    // Login shell PATH restores (POSIX and fish) and persistent orcad daemons restore ORCA_CLI_BIN_DIR ahead of /usr/bin.
    env.ORCA_CLI_BIN_DIR = shimDir
  }
  const currentPath = env.PATH ?? process.env.PATH ?? ''
  const entries = currentPath.split(':').filter((entry) => entry.length > 0 && entry !== shimDir)
  env.PATH = [shimDir, ...entries].join(':')
  if (env.BROWSER === undefined && process.env.BROWSER === undefined) {
    // Route $BROWSER-aware CLIs (e.g. aws sso, gh) through the same mobile-aware open shim.
    env.BROWSER = 'open'
  }
  return shimDir
}
