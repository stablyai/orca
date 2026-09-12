import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import {
  buildWindowsCmdCommand,
  buildWindowsCmdShimCommandLine
} from '../../../shared/child-process/windows-command-line'
import { getCmdExePath } from '../../../shared/windows-batch-spawn'
import {
  WINDOWS_BUN_PTY_GATE_ENV,
  WINDOWS_BUN_PTY_RUNTIME_OPTION_KEYS,
  type WindowsBunPtyGateRequest
} from './windows-bun-pty-gate'

const CLEAR_SEQUENCE = '\x1b[3J\x1b[2J\x1b[H'
const CLEANUP_MAX_RETRIES = 5
const CLEANUP_RETRY_DELAY_MS = 50

export function resolveWindowsBunPtyGateEntry(
  runtimeDir = __dirname,
  pathExists: (path: string) => boolean = existsSync
): string {
  const directory = runtimeDir.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked')
  const candidates = [
    join(directory, 'windows-bun-pty-gate-entry.js'),
    join(directory, '..', 'windows-bun-pty-gate-entry.js')
  ]
  return candidates.find(pathExists) ?? candidates[0]!
}

function removeLaunchDirectory(directory: string): void {
  try {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: CLEANUP_MAX_RETRIES,
      retryDelay: CLEANUP_RETRY_DELAY_MS
    })
  } catch (error) {
    console.warn(`[pty] failed to remove Windows Bun launch directory ${directory}:`, error)
  }
}

export type WindowsBunPtyLaunch = {
  command: string[]
  clearCommand: string[]
  env: Record<string, string>
  windowsVerbatimArguments: boolean
  release(): void
  dispose(): void
}

export function createWindowsBunPtyLaunch(
  args: {
    file: string
    args: string[]
    env: Record<string, string>
    cwd?: string
  },
  deps: { workerPath?: string; runtimePath?: string } = {}
): WindowsBunPtyLaunch {
  if (win32.basename(args.file).toLowerCase() === 'cmd.exe') {
    buildWindowsCmdCommand(args.file, args.args)
  }
  const workerPath = deps.workerPath ?? resolveWindowsBunPtyGateEntry()
  if (!existsSync(workerPath)) {
    throw new Error(`Windows PTY gate entry not found: ${workerPath}`)
  }
  const directory = mkdtempSync(join(tmpdir(), 'orca-bun-pty-'))
  const gatePath = join(directory, 'job-assigned')
  const requestPath = join(directory, 'request.json')
  const configPath = join(directory, 'bunfig.toml')
  const clearPath = join(directory, 'clear.cmd')
  const cmdExe = getCmdExePath()
  let released = false
  let disposed = false
  const env: Record<string, string> = { ...args.env, [WINDOWS_BUN_PTY_GATE_ENV]: gatePath }
  const runtimeOptions: WindowsBunPtyGateRequest['runtimeOptions'] = {}
  for (const key of WINDOWS_BUN_PTY_RUNTIME_OPTION_KEYS) {
    if (env[key] !== undefined) {
      runtimeOptions[key] = env[key]
    }
    delete env[key]
  }

  try {
    writeFileSync(
      requestPath,
      JSON.stringify({
        file: args.file,
        args: args.args,
        cwd: args.cwd ?? process.cwd(),
        gatePath,
        runtimeOptions
      } satisfies WindowsBunPtyGateRequest),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    )
    writeFileSync(configPath, '', { flag: 'wx', mode: 0o600 })
    writeFileSync(clearPath, `@echo off\r\n<nul set /p "=${CLEAR_SEQUENCE}"\r\n`, {
      encoding: 'ascii',
      flag: 'wx'
    })
  } catch (error) {
    removeLaunchDirectory(directory)
    throw error
  }

  return {
    // Run outside the workspace so its bunfig/.env/preloads cannot execute before job assignment.
    command: [
      deps.runtimePath ?? process.execPath,
      '--no-env-file',
      `--config=${configPath}`,
      `--cwd=${directory}`,
      workerPath,
      requestPath
    ],
    clearCommand: [cmdExe, buildWindowsCmdShimCommandLine(clearPath, [])],
    env,
    windowsVerbatimArguments: false,
    release() {
      if (released) {
        return
      }
      writeFileSync(gatePath, '', { flag: 'wx' })
      released = true
    },
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      removeLaunchDirectory(directory)
    }
  }
}
