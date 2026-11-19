// Use Windows separators even when planning commands or testing from a POSIX host.
import { win32 as pathWin32 } from 'node:path'

function readNonEmptyWindowsEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key]?.trim()
  if (direct) {
    return direct
  }
  const lowerKey = key.toLowerCase()
  for (const [envKey, value] of Object.entries(env)) {
    if (envKey.toLowerCase() === lowerKey) {
      const trimmed = value?.trim()
      if (trimmed) {
        return trimmed
      }
    }
  }
  return undefined
}

// Absolute system paths avoid stripped or shadowed Electron PATH entries.
function systemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return (
    readNonEmptyWindowsEnv(env, 'SystemRoot') ??
    readNonEmptyWindowsEnv(env, 'windir') ??
    'C:\\Windows'
  )
}

export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  return pathWin32.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export function windowsSystem32Binary(
  fileName: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return pathWin32.join(systemRoot(env), 'System32', fileName)
}

export function resolveWindowsComSpec(
  env?: NodeJS.ProcessEnv,
  fallbackEnv: NodeJS.ProcessEnv = process.env
): string {
  const explicit =
    (env ? readNonEmptyWindowsEnv(env, 'ComSpec') : undefined) ??
    readNonEmptyWindowsEnv(fallbackEnv, 'ComSpec')
  if (explicit) {
    return explicit
  }
  const root =
    (env
      ? (readNonEmptyWindowsEnv(env, 'SystemRoot') ?? readNonEmptyWindowsEnv(env, 'windir'))
      : undefined) ?? systemRoot(fallbackEnv)
  return pathWin32.join(root, 'System32', 'cmd.exe')
}
