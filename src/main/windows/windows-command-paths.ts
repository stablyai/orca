import { delimiter, join, win32 } from 'node:path'
import { existsSync } from 'node:fs'

/** Absolute path because service-launched Electron can omit System32 from PATH. */
export function getSystem32ExePath(exe: string, env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot?.trim()
  const root = systemRoot && /^[a-z]:[\\/]/i.test(systemRoot) ? systemRoot : 'C:\\Windows'
  return win32.join(root, 'System32', exe)
}

export function getRegExePath(env: NodeJS.ProcessEnv = process.env): string {
  return getSystem32ExePath('reg.exe', env)
}

export function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (process.platform !== 'win32') {
    return command
  }
  if (/[\\/]/.test(command) || /\.[a-z0-9]+$/i.test(command)) {
    return command
  }

  const pathEnv = env.PATH ?? env.Path
  if (!pathEnv) {
    return command
  }

  for (const directory of pathEnv.split(delimiter).filter(Boolean)) {
    for (const name of [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command]) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) {
        return candidate
      }
    }
  }
  return command
}
