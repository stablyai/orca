import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import {
  APPIMAGE_CLI_COMMAND_NAMES,
  buildElectronRunAsNodeEnv,
  findFirstCommandCandidate
} from './appimage-cli-redirect'

type RedirectResult =
  | {
      redirected: false
    }
  | {
      redirected: true
      status: number
    }

type RedirectOptions = {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  isPackaged?: boolean
  resourcesPath?: string
  execPath?: string
  commandNames?: readonly string[]
  exists?: typeof existsSync
  spawn?: typeof spawnSync
}

const HELP_FLAGS = new Set(['--help', '-h', 'help'])
// Why: mirror the AppImage redirect — these are Chromium desktop flags, not CLI
// args, so drop them before deciding whether argv is a CLI command.
const DESKTOP_FLAGS = new Set(['--no-sandbox'])
// Why: the SUID-sandbox abort is specific to the extracted per-version runtime
// tree (~/.config/orca-runtime/versions/<ver>/orca-ide), which a non-root user
// unpacks so chrome-sandbox is never root:root 4755. A native deb/rpm install
// (/opt/Orca/orca-ide) ships chrome-sandbox root-owned and must not be rerouted.
function isExtractedRuntimeExecPath(execPath: string): boolean {
  // Normalize both separator styles and collapse `..` so a traversal path
  // (`.../orca-runtime/versions/../native/orca-ide`) can't sneak past a raw
  // substring match, then require `orca-runtime/versions/<something>` as adjacent
  // components rather than a substring anywhere in the string.
  const segments = posix.normalize(execPath.split(win32.sep).join(posix.sep)).split(posix.sep)
  const index = segments.lastIndexOf('orca-runtime')
  return index !== -1 && segments[index + 1] === 'versions' && segments.length > index + 2
}

/**
 * Why: on Linux the packaged app can be launched directly as the extracted
 * Electron binary (`versions/<ver>/orca-ide <cli command>`) with neither
 * ELECTRON_RUN_AS_NODE nor $APPIMAGE set — e.g. remote orchestration shelling out
 * to the per-version runtime. The main process has no in-process CLI dispatcher,
 * so it would boot the desktop GUI/serve instead of running the command, and
 * Chromium's SUID sandbox aborts first when chrome-sandbox on the non-root-owned
 * tree isn't root:root 4755. Detect a headless CLI-shaped launch and re-run it in
 * Electron node mode (which never boots the zygote) BEFORE the single-instance
 * lock and app-ready path, then exit with the CLI's status.
 *
 * The AppImage redirect owns $APPIMAGE/$APPDIR launches; this covers the
 * extracted-tree case it deliberately excludes.
 */
export function maybeRedirectExtractedLinuxCliLaunch(
  options: RedirectOptions = {}
): RedirectResult {
  const argv = options.argv ?? process.argv
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const isPackaged = options.isPackaged ?? false
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  const execPath = options.execPath ?? process.execPath
  const exists = options.exists ?? existsSync
  const spawn = options.spawn ?? spawnSync
  // Why: only the extracted per-version tree hits the SUID-sandbox abort; a
  // native install keeps its own launch path and a root-owned chrome-sandbox.
  if (platform === 'linux' && !isExtractedRuntimeExecPath(execPath)) {
    return { redirected: false }
  }
  const cliArgs = getExtractedLinuxCliArgs(argv, env, {
    platform,
    isPackaged,
    commandNames: options.commandNames ?? APPIMAGE_CLI_COMMAND_NAMES
  })

  if (!cliArgs) {
    return { redirected: false }
  }

  const cliEntryPath = join(resourcesPath, 'app.asar.unpacked', 'out', 'cli', 'index.js')
  if (!exists(cliEntryPath)) {
    process.stderr.write(`Unable to locate the Orca CLI entrypoint at ${cliEntryPath}\n`)
    return { redirected: true, status: 1 }
  }

  const result = spawn(execPath, [cliEntryPath, ...cliArgs], {
    env: buildElectronRunAsNodeEnv(env),
    stdio: 'inherit'
  }) as SpawnSyncReturns<Buffer>

  if (result.error) {
    process.stderr.write(`${result.error.message}\n`)
    return { redirected: true, status: 1 }
  }

  return { redirected: true, status: result.status ?? 1 }
}

/**
 * Returns the CLI arguments for an extracted-tree Linux CLI launch, or null when
 * this is not one. Excludes node-mode (ELECTRON_RUN_AS_NODE), AppImage
 * ($APPIMAGE/$APPDIR — owned by the AppImage redirect), and `serve` (a real
 * browser surface that must keep the sandbox and has its own launch path).
 */
export function getExtractedLinuxCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  options: {
    platform: NodeJS.Platform
    isPackaged: boolean
    commandNames: readonly string[]
  }
): string[] | null {
  if (options.platform !== 'linux' || !options.isPackaged) {
    return null
  }
  // Why: node mode already runs the CLI directly; the AppImage redirect handles
  // $APPIMAGE/$APPDIR launches before this one is consulted.
  if (env.ELECTRON_RUN_AS_NODE === '1' || env.APPIMAGE || env.APPDIR) {
    return null
  }

  const args = argv.slice(1)
  if (args.length === 0) {
    return null
  }
  const cliArgs = args.filter((arg) => !DESKTOP_FLAGS.has(arg))
  if (cliArgs.some((arg) => HELP_FLAGS.has(arg))) {
    return cliArgs
  }

  const firstPositional = findFirstCommandCandidate(cliArgs)
  // Why: `serve` opens real browser surfaces and owns its own Electron launch, so
  // it must NOT be rerouted into node mode here.
  if (!firstPositional || firstPositional === 'serve') {
    return null
  }
  return new Set(options.commandNames).has(firstPositional) ? cliArgs : null
}
