import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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
// Why: the main tsconfig cannot import the CLI project, but AppImage direct
// launches need a conservative allow-list before bypassing the GUI startup.
const APPIMAGE_CLI_COMMAND_NAMES = [
  'agent',
  'automations',
  'back',
  'capture',
  'check',
  'clear',
  'click',
  'clipboard',
  'computer',
  'console',
  'cookie',
  'dblclick',
  'dialog',
  'download',
  'drag',
  'environment',
  'eval',
  'exec',
  'file',
  'fill',
  'find',
  'focus',
  'forward',
  'full-screenshot',
  'geolocation',
  'get',
  'goto',
  'highlight',
  'hover',
  'inserttext',
  'intercept',
  'is',
  'keypress',
  'mouse',
  'network',
  'open',
  'orchestration',
  'pdf',
  'reload',
  'repo',
  'screenshot',
  'scroll',
  'scrollintoview',
  'select',
  'select-all',
  'serve',
  'set',
  'snapshot',
  'status',
  'storage',
  'tab',
  'terminal',
  'type',
  'uncheck',
  'upload',
  'viewport',
  'wait',
  'worktree'
]

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
    commandNames: options.commandNames ?? APPIMAGE_CLI_COMMAND_NAMES
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
  if (!env.APPIMAGE && !env.APPDIR) {
    return null
  }

  const args = argv.slice(1)
  if (args.length === 0 || args.some((arg) => APPIMAGE_DESKTOP_FLAGS.has(arg))) {
    return null
  }
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    return args
  }

  const commandNames = new Set(options.commandNames)
  const firstPositional = findFirstCommandCandidate(args)
  return firstPositional && commandNames.has(firstPositional) ? args : null
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
