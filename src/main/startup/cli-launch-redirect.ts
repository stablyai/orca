import { existsSync } from 'node:fs'
import { posix, resolve, win32 } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { CLI_BOOLEAN_FLAGS, findCliCommandIndex } from '../../shared/cli-argument-boundary'
import { ELECTRON_NO_SANDBOX_REQUEST_ENV } from '../../shared/electron-no-sandbox-request'
import { CLI_COMMAND_NAMES } from './cli-command-names'
import { reexecHeadlessServeOnX11IfNeeded } from './headless-serve-x11-reexec'
import { argvRequestsServeMode, VALUE_TAKING_FLAGS } from './serve-mode-argv'

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
  /** Replaces this process; null when the runtime cannot, which keeps serve in-process. */
  execve?: ((file: string, args: string[], env: NodeJS.ProcessEnv) => void) | null
  /** The Ozone platform Electron resolved before main ran; defaults to Electron's switch. */
  readOzonePlatform?: () => string
}

const CLI_EARLY_EXIT_FLAGS = new Set(['--help', '-h', 'help', '--version', '-v'])
const DESKTOP_FLAGS = new Set(['--no-sandbox', '--disable-gpu'])
const DESKTOP_VALUE_FLAGS = new Set(['--disable-features'])
const CLI_LAUNCH_VALUE_FLAG_NAMES = [...VALUE_TAKING_FLAGS].map((flag) => flag.slice(2))

// Fence recursion if a wrapper drops ELECTRON_RUN_AS_NODE again.
const REDIRECT_ATTEMPT_ENV = 'ORCA_CLI_LAUNCH_REDIRECTED'

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
    const serve = getDirectServeLaunch(argv, {
      platform,
      isPackaged,
      commandNames: options.commandNames ?? CLI_COMMAND_NAMES
    })
    const execve = options.execve === undefined ? defaultExecve() : options.execve
    if (serve && execve && exists(cliEntryPath)) {
      execDirectServe(execve, execPath, cliEntryPath, serve, env)
    }
    // In-process serve missed the CLI spawn that pins X11.
    reexecHeadlessServeOnX11IfNeeded({
      isServeMode: argvRequestsServeMode(argv),
      argv,
      platform,
      execPath,
      env,
      execve: execve ?? null,
      readResolvedOzonePlatform: options.readOzonePlatform
    })
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

type DirectServeLaunch = { args: string[]; userDataPath: string | null; noSandbox: boolean }

/** Route direct serve through the CLI for profile/supervisor semantics; exec preserves PID and signal ownership. */
export function getDirectServeLaunch(
  argv: string[],
  options: { platform: NodeJS.Platform; isPackaged: boolean; commandNames: readonly string[] }
): DirectServeLaunch | null {
  if (!options.isPackaged || options.platform !== 'linux') {
    return null
  }
  const args = argv.slice(1)
  const commandIndex = findCommandIndex(args, options.commandNames)
  if (commandIndex === -1 || args[commandIndex] !== 'serve') {
    return null
  }
  // The CLI reads profile identity from ORCA_USER_DATA_PATH, not --user-data-dir.
  let userDataPath: string | null = null
  const leading: string[] = []
  for (let index = 0; index < commandIndex; index += 1) {
    const arg = args[index]!
    if (arg.startsWith('--user-data-dir=')) {
      userDataPath = arg.slice('--user-data-dir='.length)
    } else if (arg === '--user-data-dir' && index + 1 < commandIndex) {
      userDataPath = args[++index]!
    } else {
      leading.push(arg)
    }
  }
  const rest = [...leading, ...args.slice(commandIndex)]
  return {
    // Strip everywhere: serve accepts no desktop flags, though in-process serve once tolerated trailing ones.
    args: stripDesktopFlags(rest, rest.length),
    userDataPath: userDataPath ? resolve(userDataPath) : null,
    noSandbox: rest.includes('--no-sandbox')
  }
}

function execDirectServe(
  execve: NonNullable<CliLaunchRedirectOptions['execve']>,
  execPath: string,
  cliEntryPath: string,
  serve: DirectServeLaunch,
  env: NodeJS.ProcessEnv
): void {
  const childEnv = buildElectronRunAsNodeEnv(env)
  // Do not fence server terminals with the redirect marker; exec sets ELECTRON_RUN_AS_NODE itself.
  delete childEnv[REDIRECT_ATTEMPT_ENV]
  if (serve.userDataPath) {
    childEnv.ORCA_USER_DATA_PATH = serve.userDataPath
  }
  if (serve.noSandbox) {
    childEnv[ELECTRON_NO_SANDBOX_REQUEST_ENV] = '1'
  }
  try {
    execve(execPath, [execPath, cliEntryPath, ...serve.args], childEnv)
  } catch (error) {
    process.stderr.write(
      `[serve] Serving in-process; could not start the Orca CLI: ${error instanceof Error ? error.message : String(error)}\n`
    )
  }
}

function defaultExecve(): CliLaunchRedirectOptions['execve'] {
  const execve = process.execve
  return execve ? (file, args, env) => execve.call(process, file, args, env) : null
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
  return getEntryPathLaunchArgs(argv, cliEntryPath, options) ?? getCommandLaunchArgs(argv, options)
}

function getEntryPathLaunchArgs(
  argv: string[],
  cliEntryPath: string,
  options: { platform: NodeJS.Platform; commandNames: readonly string[] }
): string[] | null {
  const expectedCliPath = normalizePathForPlatform(cliEntryPath, options.platform)
  // Only argv[1] is the launcher entrypoint; later positionals can name the CLI during desktop launches.
  if (!argv[1] || normalizePathForPlatform(argv[1], options.platform) !== expectedCliPath) {
    return null
  }
  const args = argv.slice(2)
  return stripDesktopFlags(args, findCommandIndex(args, options.commandNames))
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
  const commandIndex = findCommandIndex(args, options.commandNames)
  const cliArgs = stripDesktopFlags(args, commandIndex)
  const command = commandIndex === -1 ? null : args[commandIndex]
  // Direct serve execs through the CLI to preserve its PID.
  if (command && command !== 'serve') {
    return cliArgs
  }
  return hasCliEarlyExitArg(args, commandIndex) ? cliArgs : null
}

function findCommandIndex(args: readonly string[], commandNames: readonly string[]): number {
  return findCliCommandIndex(
    args,
    commandNames.map((name) => [name]),
    CLI_LAUNCH_VALUE_FLAG_NAMES
  )
}

function stripDesktopFlags(args: readonly string[], commandIndex: number): string[] {
  const boundary = commandIndex === -1 ? findLeadingFlagBoundary(args) : commandIndex
  const cliArgs: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (index < boundary) {
      if (DESKTOP_FLAGS.has(arg)) {
        continue
      }
      if (DESKTOP_VALUE_FLAGS.has(flagName(arg))) {
        if (!arg.includes('=') && args[index + 1] && !args[index + 1]!.startsWith('-')) {
          index += 1
        }
        continue
      }
    }
    cliArgs.push(arg)
  }
  return cliArgs
}

function findLeadingFlagBoundary(args: readonly string[]): number {
  let index = 0
  while (index < args.length) {
    const token = args[index]!
    if (token === '--' || !token.startsWith('-')) {
      return index
    }
    index += 1
    if (takesLaunchValue(token, args[index])) {
      index += 1
    }
  }
  return index
}

function hasCliEarlyExitArg(args: readonly string[], commandIndex: number): boolean {
  let index = 0
  let positionalCount = 0
  while (index < args.length) {
    const token = args[index]!
    if (token === '--') {
      return false
    }
    if (
      CLI_EARLY_EXIT_FLAGS.has(token) &&
      (token !== 'help' || positionalCount === 0 || commandIndex !== -1)
    ) {
      return true
    }
    if (!token.startsWith('-')) {
      if (token === 'help' && (positionalCount === 0 || commandIndex !== -1)) {
        return true
      }
      positionalCount += 1
    }
    index += 1
    if (takesLaunchValue(token, args[index])) {
      index += 1
    }
  }
  return false
}

function takesLaunchValue(token: string, next: string | undefined): boolean {
  if (
    !next ||
    next.startsWith('-') ||
    !token.startsWith('-') ||
    token.includes('=') ||
    CLI_EARLY_EXIT_FLAGS.has(token) ||
    DESKTOP_FLAGS.has(token)
  ) {
    return false
  }
  const name = flagName(token)
  return DESKTOP_VALUE_FLAGS.has(name) || !CLI_BOOLEAN_FLAGS.has(name.replace(/^-+/, ''))
}

function flagName(arg: string): string {
  const equalsIndex = arg.indexOf('=')
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex)
}

function buildPackagedCliEntryPath(platform: NodeJS.Platform, resourcesPath: string): string {
  return getPathApi(platform).join(resourcesPath, 'app.asar.unpacked', 'out', 'cli', 'index.js')
}

function normalizePathForPlatform(value: string, platform: NodeJS.Platform): string {
  const pathApi = getPathApi(platform)
  const normalized = pathApi.normalize(pathApi.isAbsolute(value) ? value : pathApi.resolve(value))
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function getPathApi(platform: NodeJS.Platform): typeof win32 | typeof posix {
  return platform === 'win32' ? win32 : posix
}

function buildElectronRunAsNodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env }
  // Preserve user Node options while hiding them from Electron bootstrap.
  childEnv.ORCA_NODE_OPTIONS = env.NODE_OPTIONS ?? ''
  childEnv.ORCA_NODE_REPL_EXTERNAL_MODULE = env.NODE_REPL_EXTERNAL_MODULE ?? ''
  childEnv.ELECTRON_RUN_AS_NODE = '1'
  childEnv[REDIRECT_ATTEMPT_ENV] = '1'
  delete childEnv.NODE_OPTIONS
  delete childEnv.NODE_REPL_EXTERNAL_MODULE
  return childEnv
}
