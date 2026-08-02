import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

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
  exists?: typeof existsSync
  spawn?: typeof spawnSync
}

// Why: set on the re-spawned node-mode child so a failure to honor
// ELECTRON_RUN_AS_NODE can't make us redirect forever in a tight loop.
const REDIRECT_ATTEMPT_ENV = 'ORCA_PACKAGED_CLI_ENTRY_REDIRECTED'

/**
 * Why: on Windows the bundled native launcher runs `Orca.exe <unpacked CLI entry>`
 * with ELECTRON_RUN_AS_NODE=1. When that env var is dropped (e.g. a wrapper or
 * shell that resets it), Orca boots as a GUI, loses the single-instance lock to
 * an already-running window, and exits silently with no stdout. This detects the
 * CLI-shaped launch — argv carrying the known in-package CLI entry path — and
 * re-runs it in Electron node mode BEFORE the lock gate, then exits with the
 * CLI's status.
 *
 * Security: the spawned program is always `execPath` (Orca.exe) and the script
 * is always `cliEntryPath`, derived solely from `resourcesPath` + a fixed
 * relative path — never taken from argv. argv only contributes the trailing
 * CLI arguments forwarded to the already-trusted in-package CLI, and the
 * redirect only fires when an argv element exactly equals that computed path,
 * so it cannot be coerced into spawning an arbitrary script.
 */
export function maybeRedirectPackagedCliEntryLaunch(options: RedirectOptions = {}): RedirectResult {
  const argv = options.argv ?? process.argv
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const isPackaged = options.isPackaged ?? false
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  const execPath = options.execPath ?? process.execPath
  const exists = options.exists ?? existsSync
  const spawn = options.spawn ?? spawnSync
  const cliEntryPath = buildPackagedCliEntryPath(platform, resourcesPath)
  const cliArgs = getPackagedCliEntryArgs(argv, cliEntryPath, platform)

  if (!isPackaged || !cliArgs) {
    return { redirected: false }
  }
  if (env[REDIRECT_ATTEMPT_ENV] === '1') {
    process.stderr.write('Unable to start the Orca CLI through Electron node mode.\n')
    return { redirected: true, status: 1 }
  }
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
 * Returns the CLI arguments that follow the in-package CLI entrypoint in argv,
 * or null when this is not a Windows CLI-shaped launch. Scoped to win32 because
 * the AppImage redirect already covers the Linux equivalent.
 */
export function getPackagedCliEntryArgs(
  argv: string[],
  cliEntryPath: string,
  platform: NodeJS.Platform
): string[] | null {
  if (platform !== 'win32') {
    return null
  }
  const expectedCliPath = normalizePathForPlatform(cliEntryPath, platform)
  const cliEntryIndex = argv.findIndex(
    (arg, index) => index > 0 && normalizePathForPlatform(arg, platform) === expectedCliPath
  )
  return cliEntryIndex === -1 ? null : argv.slice(cliEntryIndex + 1)
}

function buildPackagedCliEntryPath(platform: NodeJS.Platform, resourcesPath: string): string {
  return getPathApi(platform).join(resourcesPath, 'app.asar.unpacked', 'out', 'cli', 'index.js')
}

function normalizePathForPlatform(value: string, platform: NodeJS.Platform): string {
  const pathApi = getPathApi(platform)
  const normalized = pathApi.normalize(pathApi.isAbsolute(value) ? value : pathApi.resolve(value))
  // Why: Windows paths are case-insensitive, so compare case-folded.
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function getPathApi(platform: NodeJS.Platform): typeof win32 | typeof posix {
  return platform === 'win32' ? win32 : posix
}

function buildElectronRunAsNodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env }
  // Why: the CLI re-reads these from the ORCA_-prefixed copies; clearing the
  // originals keeps Electron's own node bootstrap from inheriting them.
  childEnv.ORCA_NODE_OPTIONS = env.NODE_OPTIONS ?? ''
  childEnv.ORCA_NODE_REPL_EXTERNAL_MODULE = env.NODE_REPL_EXTERNAL_MODULE ?? ''
  childEnv.ELECTRON_RUN_AS_NODE = '1'
  childEnv[REDIRECT_ATTEMPT_ENV] = '1'
  delete childEnv.NODE_OPTIONS
  delete childEnv.NODE_REPL_EXTERNAL_MODULE
  return childEnv
}
