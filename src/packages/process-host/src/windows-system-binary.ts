// Use Windows separators even when planning commands or testing from a POSIX host.
import { win32 as pathWin32 } from 'node:path'
import { readWindowsEnv } from './windows-cmd-shim-resolution'

// Absolute system paths avoid stripped or shadowed Electron PATH entries.
function systemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return readWindowsEnv(env, 'SystemRoot', 'windir') ?? 'C:\\Windows'
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
