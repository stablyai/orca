import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  PACKAGED_LINUX_CLI_COMMAND_NAMES,
  PACKAGED_LINUX_CLI_SHIM_NAMES
} from '../../shared/packaged-linux-cli-command-names'

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
const VERSION_FLAGS = new Set(['--version', '-v', '-V'])
const APPIMAGE_DESKTOP_FLAGS = new Set(['--no-sandbox'])
const CLI_FLAGS_WITH_VALUES = new Set(['--environment', '--pairing-code'])
const ELECTRON_DESKTOP_VALUE_FLAGS = new Set(['--user-data-dir'])
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
    commandNames: options.commandNames ?? [
      ...PACKAGED_LINUX_CLI_COMMAND_NAMES,
      ...PACKAGED_LINUX_CLI_SHIM_NAMES
    ]
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

export function getAppImageCliArgs(
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
  const args = argv.slice(1)
  if (args.length === 0) {
    return null
  }
  if (args.some((arg) => ELECTRON_DESKTOP_VALUE_FLAGS.has(flagName(arg)))) {
    return null
  }
  const cliArgs = args.filter((arg) => !APPIMAGE_DESKTOP_FLAGS.has(arg))
  if (cliArgs.length === 1 && VERSION_FLAGS.has(cliArgs[0])) {
    return cliArgs
  }
  const firstPositional = findFirstCommandCandidate(cliArgs)
  if (firstPositional === 'serve' && !env.APPIMAGE && !env.APPDIR) {
    // Why: env-less packaged serve already has an in-process pre-GUI path; a blocking child would not receive PID-targeted termination.
    return null
  }
  if (cliArgs.some((arg) => HELP_FLAGS.has(arg))) {
    return cliArgs
  }

  const commandNames = new Set(options.commandNames)
  return firstPositional && commandNames.has(firstPositional) ? cliArgs : null
}

function findFirstCommandCandidate(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('-')) {
      return arg
    }
    const name = flagName(arg)
    if (CLI_FLAGS_WITH_VALUES.has(name) && !arg.includes('=')) {
      index += 1
    }
  }
  return null
}

function flagName(arg: string): string {
  return arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
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
