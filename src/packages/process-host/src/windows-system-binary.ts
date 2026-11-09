// Use Windows separators even when planning commands or testing from a POSIX host.
import { win32 as pathWin32 } from 'node:path'

// Absolute system paths avoid stripped or shadowed Electron PATH entries.
function systemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows'
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
