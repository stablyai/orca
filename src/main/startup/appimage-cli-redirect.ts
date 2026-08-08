import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { APPIMAGE_CLI_COMMAND_NAMES } from '../../shared/appimage-cli-command-names'

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
  spawn?: typeof spawnSync
}

const HELP_FLAGS = new Set(['--help', '-h', 'help'])
const APPIMAGE_DESKTOP_FLAGS = new Set(['--no-sandbox'])
const CLI_FLAGS_WITH_VALUES = new Set(['--environment', '--pairing-code'])
export function maybeRedirectAppImageCliLaunch(options: RedirectOptions = {}): RedirectResult {
  const argv = options.argv ?? process.argv
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const isPackaged = options.isPackaged ?? false
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  const execPath = options.execPath ?? process.execPath
  const spawn = options.spawn ?? spawnSync
  const cliArgs = getAppImageCliArgs(argv, env, {
    platform,
    isPackaged,
    commandNames: options.commandNames ?? APPIMAGE_CLI_COMMAND_NAMES,
    execPath,
    resourcesPath
  })

  if (!cliArgs) {
    return { redirected: false }
  }

  const cliEntryPath = join(resourcesPath, 'app.asar.unpacked', 'out', 'cli', 'index.js')
  if (!existsSync(cliEntryPath)) {
    process.stderr.write(`Unable to locate the Orca CLI entrypoint at ${cliEntryPath}\n`)
    return { redirected: true, status: 1 }
  }

  const childEnv = buildElectronRunAsNodeEnv(env)
  if (argv.slice(1).includes('--no-sandbox')) {
    // Why: the operator explicitly disabled Chromium's sandbox; preserve that choice when `serve` launches the Electron child.
    childEnv.ORCA_APPIMAGE_NO_SANDBOX = '1'
  }
  const result = spawn(execPath, [cliEntryPath, ...cliArgs], {
    env: childEnv,
    stdio: 'inherit'
  }) as SpawnSyncReturns<Buffer>

  if (result.error) {
    process.stderr.write(`${result.error.message}\n`)
    return { redirected: true, status: 1 }
  }

  return { redirected: true, status: result.status ?? 1 }
}

/**
 * Detect an AppImage layout even when AppRun left APPDIR/APPIMAGE unexported
 * (extracted squashfs-root launches on Ubuntu 24.04 — #13004 / root of #12677).
 */
export function isAppImagePackagedLayout(options: {
  env: NodeJS.ProcessEnv
  execPath?: string
  resourcesPath?: string
  exists?: (path: string) => boolean
}): boolean {
  const env = options.env
  if (env.APPIMAGE || env.APPDIR) {
    return true
  }
  const exists = options.exists ?? existsSync
  const candidates: string[] = []
  if (options.resourcesPath) {
    // resourcesPath is typically <appdir>/resources
    candidates.push(dirname(options.resourcesPath))
  }
  if (options.execPath) {
    candidates.push(dirname(options.execPath))
  }
  return candidates.some((dir) => exists(join(dir, 'AppRun')))
}

export function getAppImageCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  options: {
    platform: NodeJS.Platform
    isPackaged: boolean
    commandNames: readonly string[]
    execPath?: string
    resourcesPath?: string
    exists?: (path: string) => boolean
  }
): string[] | null {
  if (options.platform !== 'linux' || !options.isPackaged) {
    return null
  }
  if (
    !isAppImagePackagedLayout({
      env,
      execPath: options.execPath,
      resourcesPath: options.resourcesPath,
      exists: options.exists
    })
  ) {
    return null
  }

  const args = argv.slice(1)
  if (args.length === 0) {
    return null
  }
  const cliArgs = args.filter((arg) => !APPIMAGE_DESKTOP_FLAGS.has(arg))
  if (cliArgs.some((arg) => HELP_FLAGS.has(arg))) {
    return cliArgs
  }

  const commandNames = new Set(options.commandNames)
  const firstPositional = findFirstCommandCandidate(cliArgs)
  return firstPositional && commandNames.has(firstPositional) ? cliArgs : null
}

function findFirstCommandCandidate(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('-')) {
      return arg
    }
    const flagName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    if (CLI_FLAGS_WITH_VALUES.has(flagName) && !arg.includes('=')) {
      index += 1
    }
  }
  return null
}

function buildElectronRunAsNodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env }
  childEnv.ORCA_NODE_OPTIONS = env.NODE_OPTIONS ?? ''
  childEnv.ORCA_NODE_REPL_EXTERNAL_MODULE = env.NODE_REPL_EXTERNAL_MODULE ?? ''
  childEnv.ELECTRON_RUN_AS_NODE = '1'
  delete childEnv.NODE_OPTIONS
  delete childEnv.NODE_REPL_EXTERNAL_MODULE
  return childEnv
}
