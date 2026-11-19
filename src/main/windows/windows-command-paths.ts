import { statSync } from 'node:fs'
import { delimiter, join, win32 } from 'node:path'

/** Windows env key casing varies; select the child env key before handling its value. */
function readEnv(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  // Node sorts child env keys and keeps the first case-insensitive match.
  for (const key of Object.keys(env).sort()) {
    if (wanted.has(key.toLowerCase())) {
      const value = env[key]
      return typeof value === 'string' && value.trim() ? value.trim() : undefined
    }
  }
  return undefined
}

/** Absolute path because service-launched Electron can omit System32 from PATH. */
export function getSystem32ExePath(exe: string, env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = readEnv(env, 'SystemRoot') ?? readEnv(env, 'windir')
  const root = systemRoot && /^[a-z]:[\\/]/i.test(systemRoot) ? systemRoot : 'C:\\Windows'
  return win32.join(root, 'System32', exe)
}

export function getRegExePath(env: NodeJS.ProcessEnv = process.env): string {
  return getSystem32ExePath('reg.exe', env)
}

function isExecutableFile(candidate: string): boolean {
  try {
    return statSync(candidate, { throwIfNoEntry: false })?.isFile() ?? false
  } catch {
    // Unreadable or malformed PATH entries must not abort resolution.
    return false
  }
}

function unquote(segment: string): string {
  const value = segment.trim()
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value
}

export function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (process.platform !== 'win32') {
    return command
  }
  if (/[\\/]/.test(command)) {
    return command
  }

  const pathEnv = readEnv(env, 'PATH')
  if (!pathEnv) {
    return command
  }

  const hasExplicitExtension = /\.[a-z0-9]+$/i.test(command)
  const names = hasExplicitExtension
    ? [command]
    : [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command]

  for (const segment of pathEnv.split(delimiter)) {
    const directory = unquote(segment)
    if (!directory) {
      continue
    }
    for (const name of names) {
      const candidate = join(directory, name)
      if (isExecutableFile(candidate)) {
        return candidate
      }
    }
  }
  return command
}
