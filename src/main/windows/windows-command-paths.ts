import { delimiter, win32 } from 'node:path'
import { statSync } from 'node:fs'

const WINDOWS_EXECUTABLE_EXTENSION_RE = /\.(cmd|exe|bat|com)$/i

// Cloned or MSYS-derived env objects are case-sensitive even though Windows env keys are not.
function readEnvCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key]
  if (direct !== undefined) {
    return direct
  }
  const lowerKey = key.toLowerCase()
  for (const [envKey, value] of Object.entries(env)) {
    if (envKey.toLowerCase() === lowerKey && value !== undefined) {
      return value
    }
  }
  return undefined
}

/** Absolute path because service-launched Electron can omit System32 from PATH. */
export function getSystem32ExePath(exe: string, env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = readEnvCaseInsensitive(env, 'SystemRoot')?.trim()
  const root = systemRoot && /^[a-z]:[\\/]/i.test(systemRoot) ? systemRoot : 'C:\\Windows'
  return win32.join(root, 'System32', exe)
}

export function getRegExePath(env: NodeJS.ProcessEnv = process.env): string {
  return getSystem32ExePath('reg.exe', env)
}

export function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string {
  if (process.platform !== 'win32') {
    return command
  }
  if (/[\\/]/.test(command)) {
    return command
  }

  const pathEnv = readEnvCaseInsensitive(env, 'PATH')
  if (!pathEnv) {
    return command
  }

  const baseDir = cwd || process.cwd()
  const names = WINDOWS_EXECUTABLE_EXTENSION_RE.test(command)
    ? [command]
    : [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command]

  for (const rawDirectory of pathEnv.split(delimiter)) {
    const directory = rawDirectory
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .trim()
    if (!directory) {
      continue
    }
    for (const name of names) {
      const candidate = win32.resolve(baseDir, directory, name)
      try {
        if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
          return candidate
        }
      } catch {
        // Skip unreadable or malformed PATH entries instead of aborting command lookup.
      }
    }
  }
  return command
}
