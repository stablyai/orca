import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { runProcessSync } from '../../shared/child-process/run-process'
import { CLI_GLOBAL_VALUE_FLAGS, findCliCommandIndex } from '../../shared/cli-argument-boundary'
import { CLI_COMMAND_NAMES } from './cli-command-names'

export type CliLaunchRedirectResult = { redirected: false } | { redirected: true; status: number }

export type CliLaunchRedirectOptions = {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  isPackaged?: boolean
  resourcesPath?: string
  execPath?: string
  commandNames?: readonly string[]
  exists?: typeof existsSync
  run?: typeof runProcessSync
}

const HELP_FLAGS = new Set(['--help', '-h', 'help'])
const DESKTOP_FLAGS = new Set(['--no-sandbox', '--disable-gpu'])

// Fence recursion if a wrapper drops ELECTRON_RUN_AS_NODE again.
const REDIRECT_ATTEMPT_ENV = 'ORCA_CLI_LAUNCH_REDIRECTED'

// Redirect packaged CLI-shaped launches before Chromium initializes.
export function maybeRedirectCliLaunch(
  options: CliLaunchRedirectOptions = {}
): CliLaunchRedirectResult {
  const argv = options.argv ?? process.argv
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const isPackaged = options.isPackaged ?? false
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  const execPath = options.execPath ?? process.execPath
  const exists = options.exists ?? existsSync
  const run = options.run ?? runProcessSync
  const cliEntryPath = buildPackagedCliEntryPath(platform, resourcesPath)
  const cliArgs = getCliLaunchArgs(argv, cliEntryPath, {
    platform,
    isPackaged,
    commandNames: options.commandNames ?? CLI_COMMAND_NAMES
  })

  if (!cliArgs) {
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

  const childEnv = buildElectronRunAsNodeEnv(env)
  try {
    const result = run({
      program: execPath,
      args: [cliEntryPath, ...cliArgs],
      env: childEnv,
      stdio: 'inherit',
      timeoutMs: null
    })
    return { redirected: true, status: result.code ?? 1 }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return { redirected: true, status: 1 }
  }
}

export function getCliLaunchArgs(
  argv: string[],
  cliEntryPath: string,
  options: {
    platform: NodeJS.Platform
    isPackaged: boolean
    commandNames: readonly string[]
  }
): string[] | null {
  if (!options.isPackaged) {
    return null
  }
  return (
    getEntryPathLaunchArgs(argv, cliEntryPath, options.platform) ??
    getCommandLaunchArgs(argv, options)
  )
}

function getEntryPathLaunchArgs(
  argv: string[],
  cliEntryPath: string,
  platform: NodeJS.Platform
): string[] | null {
  const expectedCliPath = normalizePathForPlatform(cliEntryPath, platform)
  const cliEntryIndex = argv.findIndex(
    (arg, index) => index > 0 && normalizePathForPlatform(arg, platform) === expectedCliPath
  )
  return cliEntryIndex === -1 ? null : argv.slice(cliEntryIndex + 1)
}

function getCommandLaunchArgs(
  argv: string[],
  options: { platform: NodeJS.Platform; commandNames: readonly string[] }
): string[] | null {
  if (options.platform !== 'linux') {
    return null
  }
  const args = argv.slice(1)
  if (args.length === 0) {
    return null
  }
  const commandPaths = options.commandNames.map((name) => [name])
  const commandIndex = findCliCommandIndex(args, commandPaths, CLI_GLOBAL_VALUE_FLAGS)
  const cliArgs = args.filter(
    (arg, index) => (commandIndex !== -1 && index > commandIndex) || !DESKTOP_FLAGS.has(arg)
  )
  if (cliArgs.some((arg) => HELP_FLAGS.has(arg))) {
    return cliArgs
  }

  const command = commandIndex === -1 ? null : args[commandIndex]
  // Keep direct serve in-process so signals reach its full child tree.
  return command && command !== 'serve' ? cliArgs : null
}

function buildPackagedCliEntryPath(platform: NodeJS.Platform, resourcesPath: string): string {
  return getPathApi(platform).join(resourcesPath, 'app.asar.unpacked', 'out', 'cli', 'index.js')
}

function normalizePathForPlatform(value: string, platform: NodeJS.Platform): string {
  const pathApi = getPathApi(platform)
  const normalized = pathApi.normalize(pathApi.isAbsolute(value) ? value : pathApi.resolve(value))
  // Windows path comparisons are case-insensitive.
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function getPathApi(platform: NodeJS.Platform): typeof win32 | typeof posix {
  return platform === 'win32' ? win32 : posix
}

function buildElectronRunAsNodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env }
  // Preserve user values without exposing them to Electron's bootstrap.
  childEnv.ORCA_NODE_OPTIONS = env.NODE_OPTIONS ?? ''
  childEnv.ORCA_NODE_REPL_EXTERNAL_MODULE = env.NODE_REPL_EXTERNAL_MODULE ?? ''
  childEnv.ELECTRON_RUN_AS_NODE = '1'
  childEnv[REDIRECT_ATTEMPT_ENV] = '1'
  delete childEnv.NODE_OPTIONS
  delete childEnv.NODE_REPL_EXTERNAL_MODULE
  return childEnv
}
