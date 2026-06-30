import { existsSync } from 'fs'
import { delimiter, join } from 'path'

export const WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR = 'UNSAFE_WINDOWS_BATCH_ARGUMENTS'

export type SpawnCommand = { spawnCmd: string; spawnArgs: string[] }

type SpawnPlan = SpawnCommand & { pathFallbackCommand?: string }

function getCmdExePath(): string {
  return process.env.ComSpec || `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\cmd.exe`
}

function isWindowsBatchScript(commandPath: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(commandPath)
}

function hasUnsafeWindowsBatchSyntax(value: string): boolean {
  return /[&|<>^"%!\r\n]/.test(value)
}

function quoteWindowsBatchToken(value: string): string {
  if (hasUnsafeWindowsBatchSyntax(value)) {
    throw new Error(WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR)
  }
  return `"${value}"`
}

function resolveWindowsCommand(binary: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') {
    return binary
  }
  if (/[\\/]/.test(binary) || /\.[a-z0-9]+$/i.test(binary)) {
    return binary
  }

  const pathEnv = env.PATH ?? env.Path
  if (!pathEnv) {
    return binary
  }
  const names = [`${binary}.cmd`, `${binary}.exe`, `${binary}.bat`, binary]
  for (const directory of pathEnv.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) {
        return candidate
      }
    }
  }
  return binary
}

function getWindowsSafeSpawn(binary: string, args: string[], env: NodeJS.ProcessEnv): SpawnCommand {
  const resolvedBinary = resolveWindowsCommand(binary, env)
  if (!isWindowsBatchScript(resolvedBinary)) {
    return { spawnCmd: resolvedBinary, spawnArgs: args }
  }
  const commandLine = [resolvedBinary, ...args].map(quoteWindowsBatchToken).join(' ')
  return { spawnCmd: getCmdExePath(), spawnArgs: ['/d', '/s', '/c', commandLine] }
}

export function getSpawnPlan(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  useShell: boolean
): SpawnPlan {
  if (process.platform === 'win32' || !useShell) {
    return getWindowsSafeSpawn(binary, args, env)
  }
  if (binary.includes('/')) {
    return { spawnCmd: binary, spawnArgs: args }
  }
  return {
    spawnCmd: binary,
    spawnArgs: args,
    // Why: SSH commit/PR agents may be installed only after shell PATH
    // initialization. Resolve that path only after direct ENOENT, then spawn
    // the resolved binary directly instead of running the agent inside a shell.
    pathFallbackCommand: binary
  }
}

export function isSpawnEnoent(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || /\bENOENT\b/i.test(error.message)
}
