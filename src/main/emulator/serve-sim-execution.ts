import { execFile } from 'child_process'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'fs'
import { app } from 'electron'
import { platform, tmpdir } from 'os'
import { delimiter, dirname, join } from 'path'
import { EmulatorError } from './emulator-errors'

const EXEC_TIMEOUT_MS = 90_000
const MAC_OPEN_SHIM_DIR = join(tmpdir(), 'orca-serve-sim-open-shim')
const MAC_OPEN_SHIM_PATH = join(MAC_OPEN_SHIM_DIR, 'open')
const MAC_OPEN_SHIM = `#!/bin/sh
has_simulator_target=0
for arg in "$@"; do
  case "$arg" in
    Simulator|Simulator.app|com.apple.iphonesimulator|*Simulator.app*)
      has_simulator_target=1
      ;;
  esac
done
if [ "$has_simulator_target" = "1" ]; then
  /usr/bin/open -gj -a Simulator 2>/dev/null || /usr/bin/open "$@"
  exit 0
fi
exec /usr/bin/open "$@"
`

export type ServeSimExecutable = {
  command: string
  baseArgs: string[]
  usesElectronAsNode: boolean
}

function ensureMacOpenShim(): string | null {
  if (platform() !== 'darwin') {
    return null
  }
  try {
    mkdirSync(MAC_OPEN_SHIM_DIR, { recursive: true })
    const current = existsSync(MAC_OPEN_SHIM_PATH) ? readFileSync(MAC_OPEN_SHIM_PATH, 'utf8') : ''
    if (current !== MAC_OPEN_SHIM) {
      writeFileSync(MAC_OPEN_SHIM_PATH, MAC_OPEN_SHIM, { mode: 0o755 })
    }
    chmodSync(MAC_OPEN_SHIM_PATH, 0o755)
    return MAC_OPEN_SHIM_DIR
  } catch {
    return null
  }
}

function getServeSimEnv(executable: ServeSimExecutable): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = executable.usesElectronAsNode
    ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    : { ...process.env }
  const openShimDir = ensureMacOpenShim()
  if (openShimDir) {
    // Why: serve-sim needs Simulator.app attached for display/rotation, but Orca embeds the stream.
    env.PATH = `${openShimDir}${delimiter}${env.PATH ?? ''}`
  }
  return env
}

export function resolveServeSimExecutable(): ServeSimExecutable {
  const bundledResourcesPath =
    process.resourcesPath ??
    (process.platform === 'darwin'
      ? join(app.getPath('exe'), '..', '..', 'Resources')
      : join(app.getPath('exe'), '..', 'resources'))
  const bundled = join(bundledResourcesPath, 'serve-sim', 'dist', 'serve-sim.js')
  if (existsSync(bundled)) {
    return { command: process.execPath, baseArgs: [bundled], usesElectronAsNode: true }
  }

  const nodeModulesEntry = join(
    app.getAppPath(),
    'node_modules',
    'serve-sim',
    'dist',
    'serve-sim.js'
  )
  if (existsSync(nodeModulesEntry)) {
    const helperBin = join(dirname(nodeModulesEntry), '..', 'bin', 'serve-sim-bin')
    if (existsSync(helperBin) && process.platform !== 'win32') {
      try {
        accessSync(helperBin, constants.X_OK)
      } catch {
        chmodSync(helperBin, 0o755)
      }
    }
    return { command: process.execPath, baseArgs: [nodeModulesEntry], usesElectronAsNode: true }
  }

  return { command: 'serve-sim', baseArgs: [], usesElectronAsNode: false }
}

export function parseServeSimCommandArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inDouble = false
  let inSingle = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (char === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (char === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (char === ' ' && !inDouble && !inSingle) {
      if (current) {
        args.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }
  if (current) {
    args.push(current)
  }
  return args
}

export function stripEmulatorTargetArgs(args: string[]): string[] {
  const stripped: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--device' || arg === '-d' || arg === '--emulator' || arg === '--worktree') {
      index += 1
      continue
    }
    if (
      arg.startsWith('--device=') ||
      arg.startsWith('-d=') ||
      arg.startsWith('--emulator=') ||
      arg.startsWith('--worktree=')
    ) {
      continue
    }
    stripped.push(arg)
  }
  return stripped
}

export async function execServeSimCommand(
  executable: ServeSimExecutable,
  args: string[],
  options?: { json?: boolean; timeoutMs?: number }
): Promise<unknown> {
  const timeout = options?.timeoutMs ?? EXEC_TIMEOUT_MS
  const finalArgs = [...args]
  if (options?.json && !finalArgs.includes('-q') && !finalArgs.includes('--quiet')) {
    finalArgs.push('-q')
  }

  return new Promise((resolve, reject) => {
    execFile(
      executable.command,
      [...executable.baseArgs, ...finalArgs],
      { timeout, maxBuffer: 10 * 1024 * 1024, env: getServeSimEnv(executable) },
      (error, stdout, stderr) => {
        if (error) {
          const message =
            stdout.toString() || stderr.toString() || error.message || 'serve-sim command failed'
          if (/no serve-sim server|not running/i.test(message)) {
            reject(
              new EmulatorError(
                'emulator_no_active',
                'No active emulator for this worktree — use orca emulator list/attach or open the pane'
              )
            )
            return
          }
          reject(new EmulatorError('emulator_error', message))
          return
        }
        if (options?.json) {
          try {
            resolve(JSON.parse(stdout.toString()))
          } catch {
            resolve(stdout.toString().trim())
          }
          return
        }
        resolve(stdout.toString().trim())
      }
    )
  })
}
