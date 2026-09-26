import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export const WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR = 'UNSAFE_WINDOWS_BATCH_ARGUMENTS'

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

// Why: mirrors src/main/text-generation/commit-message-text-generation.ts. On
// Windows, npm-installed CLIs like `claude`/`codex` are usually `.cmd` shims.
// We route those through cmd.exe so Node can launch them.
export function getWindowsSafeSpawn(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv
): { spawnCmd: string; spawnArgs: string[] } {
  const resolvedBinary = resolveWindowsCommand(binary, env)
  if (!isWindowsBatchScript(resolvedBinary)) {
    return { spawnCmd: resolvedBinary, spawnArgs: args }
  }
  const commandLine = [resolvedBinary, ...args].map(quoteWindowsBatchToken).join(' ')
  return { spawnCmd: getCmdExePath(), spawnArgs: ['/d', '/s', '/c', commandLine] }
}
