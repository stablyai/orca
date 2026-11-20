// Use Windows separators even when planning commands or testing from a POSIX host.
import { win32 as pathWin32 } from 'node:path'

// Absolute system paths avoid stripped or shadowed Electron PATH entries.
/**
 * Windows spells this root three ways in practice: process.env, cloned plain objects (MSYS/Git Bash),
 * and windir. An empty spelling is a set-but-unusable value (PowerShell 7.5 allows empty env values),
 * so it must fall through like an absent one — otherwise every System32 path below goes relative.
 */
export function windowsSystemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows'
}

function systemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return windowsSystemRoot(env)
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
